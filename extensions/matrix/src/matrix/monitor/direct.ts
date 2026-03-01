import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

type DirectMessageCheck = {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
};

type DirectRoomTrackerOptions = {
  log?: (message: string) => void;
};

const DM_CACHE_TTL_MS = 30_000;

export function createDirectRoomTracker(client: MatrixClient, opts: DirectRoomTrackerOptions = {}) {
  const log = opts.log ?? (() => {});
  let lastDmUpdateMs = 0;
  let cachedSelfUserId: string | null = null;
  const memberCountCache = new Map<string, { count: number; ts: number }>();

  const ensureSelfUserId = async (): Promise<string | null> => {
    if (cachedSelfUserId) {
      return cachedSelfUserId;
    }
    try {
      cachedSelfUserId = await client.getUserId();
    } catch {
      cachedSelfUserId = null;
    }
    return cachedSelfUserId;
  };

  const refreshDmCache = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {
      return;
    }
    lastDmUpdateMs = now;
    try {
      await client.dms.update();
    } catch (err) {
      log(`matrix: dm cache refresh failed (${String(err)})`);
    }
  };

  const resolveMemberCount = async (roomId: string): Promise<number | null> => {
    const cached = memberCountCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.count;
    }
    try {
      const members = await client.getJoinedRoomMembers(roomId);
      const count = members.length;
      memberCountCache.set(roomId, { count, ts: now });
      return count;
    } catch (err) {
      log(`matrix: dm member count failed room=${roomId} (${String(err)})`);
      return null;
    }
  };

  // Returns: true = explicitly marked as DM, false = explicitly marked as NOT DM, null = unknown
  const hasDirectFlag = async (roomId: string, userId?: string): Promise<boolean | null> => {
    const target = userId?.trim();
    if (!target) {
      return null;
    }
    try {
      const state = await client.getRoomStateEvent(roomId, "m.room.member", target);
      // Explicitly true → DM, explicitly false → not DM, missing → unknown
      if (state?.is_direct === true) {
        return true;
      }
      if (state?.is_direct === false) {
        return false;
      }
      return null;
    } catch {
      return null;
    }
  };

  return {
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;
      await refreshDmCache();

      // First, check m.direct account data (Matrix spec way)
      if (client.dms.isDm(roomId)) {
        log(`matrix: dm detected via m.direct room=${roomId}`);
        return true;
      }

      // Second, check is_direct member state (explicit DM marker)
      // If explicitly marked as NOT a DM (is_direct: false), respect that
      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const senderFlag = await hasDirectFlag(roomId, senderId);
      const selfFlag = await hasDirectFlag(roomId, selfUserId ?? "");

      // If either is explicitly marked as direct → DM
      if (senderFlag === true || selfFlag === true) {
        log(`matrix: dm detected via member state room=${roomId}`);
        return true;
      }

      // If either is explicitly marked as NOT direct → NOT a DM (don't fall through to member count)
      if (senderFlag === false || selfFlag === false) {
        log(`matrix: room explicitly marked as not DM via member state room=${roomId}`);
        return false;
      }

      // If flags are unknown (null), we cannot definitively determine if this is a DM
      // Do not fall back to member count heuristic - only treat as DM with explicit markers
      // This prevents incorrectly treating 2-person topic-specific rooms as DMs

      log(`matrix: dm check room=${roomId} result=unknown no explicit dm markers`);
      return false;
    },
  };
}
