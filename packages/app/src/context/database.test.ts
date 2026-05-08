import { beforeAll, describe, expect, mock, test } from "bun:test"

let getDatabaseBootstrapPatch: typeof import("./database").getDatabaseBootstrapPatch

beforeAll(async () => {
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./database")
  getDatabaseBootstrapPatch = mod.getDatabaseBootstrapPatch
})

describe("getDatabaseBootstrapPatch", () => {
  test("does nothing before persisted state is ready", () => {
    const patch = getDatabaseBootstrapPatch(
      {
        connections: [{ id: "default" }],
        activeConnectionID: "",
        connectedConnectionID: "",
      },
      false,
      () => {
        throw new Error("should not create default connection before ready")
      },
    )

    expect(patch).toBeUndefined()
  })

  test("restores missing active and connected ids after persisted state is ready", () => {
    const patch = getDatabaseBootstrapPatch(
      {
        connections: [{ id: "saved-1" }, { id: "saved-2" }],
        activeConnectionID: "missing",
        connectedConnectionID: "missing",
      },
      true,
      () => {
        throw new Error("should not create a new default connection when saved ones exist")
      },
    )

    expect(patch).toEqual({
      activeConnectionID: "saved-1",
      connectedConnectionID: "",
    })
  })

  test("creates a default connection only when ready and the saved list is empty", () => {
    const patch = getDatabaseBootstrapPatch(
      {
        connections: [],
        activeConnectionID: "",
        connectedConnectionID: "stale",
      },
      true,
      () =>
        ({
          id: "created",
          name: "Database 1",
          driver: "mysql",
          host: "127.0.0.1",
          port: "3306",
          database: "",
          schema: "",
          username: "",
          password: "",
          connectString: "",
          objects: [],
          objectsLoaded: false,
        }) as const,
    )

    expect(patch).toEqual({
      connections: [
        {
          id: "created",
          name: "Database 1",
          driver: "mysql",
          host: "127.0.0.1",
          port: "3306",
          database: "",
          schema: "",
          username: "",
          password: "",
          connectString: "",
          objects: [],
          objectsLoaded: false,
        },
      ],
      activeConnectionID: "created",
      connectedConnectionID: "",
    })
  })
})
