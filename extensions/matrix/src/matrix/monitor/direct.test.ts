import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDirectRoomTracker } from "./direct.js";

// Mock MatrixClient
const createMockClient = (overrides: Record<string, unknown> = {}) => ({
  getUserId: vi.fn().mockResolvedValue("@user:matrix.org"),
  getJoinedRoomMembers: vi.fn().mockResolvedValue([]),
  getRoomStateEvent: vi.fn().mockResolvedValue(null),
  dms: {
    update: vi.fn().mockResolvedValue(undefined),
    isDm: vi.fn().mockReturnValue(false),
  },
  ...overrides,
});

describe("createDirectRoomTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("should detect DM via m.direct account data", async () => {
    const mockClient = createMockClient({
      dms: {
        update: vi.fn().mockResolvedValue(undefined),
        isDm: vi.fn().mockReturnValue(true),
      },
    });

    const tracker = createDirectRoomTracker(mockClient as any);
    const result = await tracker.isDirectMessage({ roomId: "!room:matrix.org" });

    expect(result).toBe(true);
    expect(mockClient.dms.isDm).toHaveBeenCalledWith("!room:matrix.org");
  });

  it("should detect DM via is_direct member state", async () => {
    const mockClient = createMockClient({
      dms: {
        update: vi.fn().mockResolvedValue(undefined),
        isDm: vi.fn().mockReturnValue(false),
      },
      getRoomStateEvent: vi.fn().mockImplementation((roomId, _eventType, userId) => {
        if (userId === "@other:matrix.org") {
          return Promise.resolve({ is_direct: true });
        }
        return Promise.reject(new Error("Not found"));
      }),
    });

    const tracker = createDirectRoomTracker(mockClient as any);
    const result = await tracker.isDirectMessage({
      roomId: "!room:matrix.org",
      senderId: "@other:matrix.org",
    });

    expect(result).toBe(true);
  });

  it("should NOT detect DM via member count when is_direct is false", async () => {
    const mockClient = createMockClient({
      dms: {
        update: vi.fn().mockResolvedValue(undefined),
        isDm: vi.fn().mockReturnValue(false),
      },
      getRoomStateEvent: vi.fn().mockResolvedValue({ is_direct: false }),
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValue([{ user_id: "@user:matrix.org" }, { user_id: "@other:matrix.org" }]),
    });

    const tracker = createDirectRoomTracker(mockClient as any);
    const result = await tracker.isDirectMessage({
      roomId: "!room:matrix.org",
      senderId: "@other:matrix.org",
    });

    // Should be false because is_direct is explicitly false
    // even though member count is 2
    expect(result).toBe(false);
  });

  it("should return false when no explicit DM markers and member count check fails", async () => {
    const mockClient = createMockClient({
      dms: {
        update: vi.fn().mockResolvedValue(undefined),
        isDm: vi.fn().mockReturnValue(false),
      },
      getRoomStateEvent: vi.fn().mockRejectedValue(new Error("Not found")),
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValue([{ user_id: "@user:matrix.org" }, { user_id: "@other:matrix.org" }]),
    });

    const tracker = createDirectRoomTracker(mockClient as any);
    const result = await tracker.isDirectMessage({
      roomId: "!room:matrix.org",
      senderId: "@other:matrix.org",
    });

    // Should be false - without explicit DM markers (m.direct or is_direct: true),
    // a room should not be treated as a DM even if it has 2 members
    expect(result).toBe(false);
  });

  it("should not detect 2-person room as DM when explicitly marked as group", async () => {
    // This is the key bug fix test:
    // A 2-person room that is NOT marked as DM (is_direct: false)
    // should NOT be treated as a DM
    const mockClient = createMockClient({
      dms: {
        update: vi.fn().mockResolvedValue(undefined),
        isDm: vi.fn().mockReturnValue(false),
      },
      getRoomStateEvent: vi.fn().mockResolvedValue({ is_direct: false }),
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValue([{ user_id: "@user:matrix.org" }, { user_id: "@other:matrix.org" }]),
    });

    const tracker = createDirectRoomTracker(mockClient as any);
    const result = await tracker.isDirectMessage({
      roomId: "!room:matrix.org",
      senderId: "@other:matrix.org",
    });

    // The key fix: even with 2 members, if is_direct is false,
    // it should NOT be treated as a DM
    expect(result).toBe(false);
  });
  it("should detect group room with 2 members as group when no DM markers", async () => {
    const mockClient = createMockClient({
      dms: {
        update: vi.fn().mockResolvedValue(undefined),
        isDm: vi.fn().mockReturnValue(false),
      },
      getRoomStateEvent: vi.fn().mockRejectedValue(new Error("Not found")),
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValue([{ user_id: "@user:matrix.org" }, { user_id: "@other:matrix.org" }]),
    });

    const tracker = createDirectRoomTracker(mockClient as any);
    const result = await tracker.isDirectMessage({
      roomId: "!room:matrix.org",
    });

    // Without explicit markers (no m.direct, no is_direct: true),
    // a 2-person room should NOT be treated as a DM
    expect(result).toBe(false);
  });
});
