import {
  composeThinkingAndContent,
  extractContentFromMessage,
  extractThinkingFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";

type RunStreamState = {
  thinkingText: string;
  contentText: string;
  contentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  displayText: string;
};

type BoundaryDropMode = "off" | "streamed-only" | "streamed-or-incoming";

function extractTextBlocksAndSignals(message: unknown): {
  textBlocks: string[];
  sawNonTextContentBlocks: boolean;
} {
  if (!message || typeof message !== "object") {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }
  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      const text = rec.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof rec.type === "string" && rec.type !== "thinking") {
      sawNonTextContentBlocks = true;
    }
  }
  return { textBlocks, sawNonTextContentBlocks };
}

function isDroppedBoundaryTextBlockSubset(params: {
  streamedTextBlocks: string[];
  finalTextBlocks: string[];
  streamedSawNonTextContentBlocks: boolean;
}): boolean {
  const { streamedTextBlocks, finalTextBlocks, streamedSawNonTextContentBlocks } = params;
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }

  // If we saw non-text content blocks (like tool calls) in the stream,
  // and the final has fewer text blocks, check if it's a valid subset.
  // We should preserve the streamed text only if the final text blocks
  // are actually a prefix or suffix match (meaning the drop is just truncation,
  // not replacement).
  if (streamedSawNonTextContentBlocks && finalTextBlocks.length < streamedTextBlocks.length) {
    // Check prefix match
    const prefixMatches = finalTextBlocks.every(
      (block, index) => streamedTextBlocks[index] === block,
    );
    if (prefixMatches) {
      return true;
    }
    // Check suffix match
    const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
    const suffixMatches = finalTextBlocks.every(
      (block, index) => streamedTextBlocks[suffixStart + index] === block,
    );
    if (suffixMatches) {
      return true;
    }
    // Final has different content - don't preserve, use the replacement
    return false;
  }

  // Check prefix match: final blocks exactly match the start of streamed blocks
  const prefixMatches = finalTextBlocks.every(
    (block, index) => streamedTextBlocks[index] === block,
  );
  if (prefixMatches) {
    return true;
  }

  // Check suffix match: final blocks exactly match the end of streamed blocks
  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
}

function shouldPreserveBoundaryDroppedText(params: {
  boundaryDropMode: BoundaryDropMode;
  streamedSawNonTextContentBlocks: boolean;
  incomingSawNonTextContentBlocks: boolean;
  streamedTextBlocks: string[];
  nextContentBlocks: string[];
}) {
  if (params.boundaryDropMode === "off") {
    return false;
  }
  const sawEligibleNonTextContent =
    params.boundaryDropMode === "streamed-or-incoming"
      ? params.streamedSawNonTextContentBlocks || params.incomingSawNonTextContentBlocks
      : params.streamedSawNonTextContentBlocks;
  if (!sawEligibleNonTextContent) {
    return false;
  }
  return isDroppedBoundaryTextBlockSubset({
    streamedTextBlocks: params.streamedTextBlocks,
    finalTextBlocks: params.nextContentBlocks,
    streamedSawNonTextContentBlocks: params.streamedSawNonTextContentBlocks,
  });
}

export class TuiStreamAssembler {
  private runs = new Map<string, RunStreamState>();

  private getOrCreateRun(runId: string): RunStreamState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        thinkingText: "",
        contentText: "",
        contentBlocks: [],
        sawNonTextContentBlocks: false,
        displayText: "",
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  private updateRunState(
    state: RunStreamState,
    message: unknown,
    showThinking: boolean,
    opts?: { boundaryDropMode?: BoundaryDropMode },
  ) {
    const thinkingText = extractThinkingFromMessage(message);
    const contentText = extractContentFromMessage(message);
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (thinkingText) {
      state.thinkingText = thinkingText;
    }
    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const boundaryDropMode = opts?.boundaryDropMode ?? "off";
      const shouldKeepStreamedBoundaryText = shouldPreserveBoundaryDroppedText({
        boundaryDropMode,
        streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
        incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
        streamedTextBlocks: state.contentBlocks,
        nextContentBlocks,
      });

      if (!shouldKeepStreamedBoundaryText) {
        state.contentText = contentText;
        state.contentBlocks = nextContentBlocks;
      }
    }
    if (sawNonTextContentBlocks) {
      state.sawNonTextContentBlocks = true;
    }

    const displayText = composeThinkingAndContent({
      thinkingText: state.thinkingText,
      contentText: state.contentText,
      showThinking,
    });

    state.displayText = displayText;
  }

  ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null {
    const state = this.getOrCreateRun(runId);
    const previousDisplayText = state.displayText;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-or-incoming",
    });

    if (!state.displayText || state.displayText === previousDisplayText) {
      return null;
    }

    return state.displayText;
  }

  finalize(runId: string, message: unknown, showThinking: boolean): string {
    const state = this.getOrCreateRun(runId);
    const streamedDisplayText = state.displayText;
    const streamedTextBlocks = [...state.contentBlocks];
    const streamedSawNonTextContentBlocks = state.sawNonTextContentBlocks;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-only",
    });
    const finalComposed = state.displayText;
    const shouldKeepStreamedText =
      streamedSawNonTextContentBlocks &&
      isDroppedBoundaryTextBlockSubset({
        streamedTextBlocks,
        finalTextBlocks: state.contentBlocks,
        streamedSawNonTextContentBlocks,
      });
    const finalText = resolveFinalAssistantText({
      finalText: shouldKeepStreamedText ? streamedDisplayText : finalComposed,
      streamedText: streamedDisplayText,
    });

    this.runs.delete(runId);
    return finalText;
  }

  drop(runId: string) {
    this.runs.delete(runId);
  }
}
