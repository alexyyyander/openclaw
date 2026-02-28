import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { resolveWhatsAppAccount } from "../../../web/accounts.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { resolveWhatsAppOutboundTarget } from "../../../whatsapp/resolve-outbound-target.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ cfg, to, allowFrom, mode, accountId }) => {
    const resolvedAccountId = accountId ?? "default";
    const account = cfg ? resolveWhatsAppAccount({ cfg, accountId: resolvedAccountId }) : undefined;
    const selfChatMode = account?.selfChatMode ?? false;
    return resolveWhatsAppOutboundTarget({ to, allowFrom, mode, selfChatMode });
  },
  sendText: async ({ to, text, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
    }),
};
