import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useSDK } from "./sdk"
import { useServer } from "./server"

type DriverKind = "mysql" | "dameng"
type SqlPrimitive = string | number | boolean | null
type SqlResultRow = SqlPrimitive[]

type ConnectionForm = {
  host: string
  port: string
  database: string
  schema: string
  username: string
  password: string
  connectString: string
}

type TableTreeNode = {
  name: string
  comment?: string
  columns?: Array<{ name: string; comment?: string }>
}

type SchemaTreeNode = {
  name: string
  tables: TableTreeNode[]
}

type DatabaseTreeNode = {
  name: string
  schemas: SchemaTreeNode[]
}

type SavedConnection = ConnectionForm & {
  id: string
  name: string
  driver: DriverKind
  objects: DatabaseTreeNode[]
  objectsLoaded: boolean
}

type DatabaseBootstrapState = {
  connections: Array<Pick<SavedConnection, "id">>
  activeConnectionID: string
  connectedConnectionID: string
}

type DatabaseBootstrapPatch = {
  connections?: SavedConnection[]
  activeConnectionID?: string
  connectedConnectionID?: string
}

export type QueryResult = {
  id: string
  sql: string
  columns: string[]
  columnComments?: string[]
  rows: SqlResultRow[]
  affectedRows: number
  durationMs: number
  timestamp: number
  source: "panel" | "file"
  filePath?: string
  error?: string
}

type QueryResponse = {
  columns?: unknown
  rows?: unknown
  affectedRows?: unknown
}

const DEFAULT_SQL = "SELECT 1;"

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

function parseServerErrorText(raw: string, fallback: string) {
  const text = raw.trim()
  if (!text) return fallback
  const parse = (value: string) => {
    const parsed = JSON.parse(value) as {
      message?: unknown
      data?: { message?: unknown }
      error?: unknown
    }
    const nested = parsed?.data?.message
    if (typeof nested === "string" && nested.trim()) return nested.trim()
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed?.error === "string" && parsed.error.trim()) return parsed.error.trim()
    return ""
  }
  try {
    const direct = parse(text)
    if (direct) return direct
  } catch {
    // Ignore and try JSON block extraction below.
  }

  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      const sliced = text.slice(start, end + 1)
      const extracted = parse(sliced)
      if (extracted) return extracted
    } catch {
      // Ignore parse errors from extracted JSON substring.
    }
  }
  return text
}

function normalizeValue(value: unknown): SqlPrimitive {
  if (value == null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `BLOB(${value.byteLength})`
  return String(value)
}

function normalizeRows(rows: unknown[][]) {
  return rows.map((row) => row.map(normalizeValue))
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function quoteSqlLiteral(input: string) {
  return `'${input.replaceAll("'", "''")}'`
}

function quoteDamengIdentifier(input: string) {
  return `"${input.trim().replaceAll('"', '""')}"`
}

function normalizeIdentifierToken(token: string) {
  const trimmed = token.trim()
  if (!trimmed) return ""
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll('""', '"')
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("``", "`")
  }
  return trimmed
}

function resolveSingleFromTable(sql: string) {
  const match =
    /\bFROM\s+("([^"]+)"|`([^`]+)`|([A-Za-z_][\w$]*))(?:\s*\.\s*("([^"]+)"|`([^`]+)`|([A-Za-z_][\w$]*)))?/i.exec(sql)
  if (!match) return null
  const first = normalizeIdentifierToken(match[1] ?? "")
  const second = normalizeIdentifierToken(match[5] ?? "")
  if (!first) return null
  if (second) return { schema: first, table: second }
  return { schema: undefined, table: first }
}

function objectKey(schema: string, table: string) {
  return `${schema.trim().toUpperCase()}::${table.trim().toUpperCase()}`
}

function addColumnToMap(
  map: Map<string, Array<{ name: string; comment?: string }>>,
  schema: string,
  table: string,
  column: string,
  comment?: string,
) {
  const name = column.trim()
  if (!name) return
  const key = objectKey(schema, table)
  const list = map.get(key) ?? []
  const index = list.findIndex((item) => item.name.toUpperCase() === name.toUpperCase())
  if (index === -1) {
    list.push({ name, comment: comment?.trim() || undefined })
  } else if (!list[index]?.comment && comment?.trim()) {
    list[index]!.comment = comment.trim()
  }
  map.set(key, list)
}

function normalizeColumnName(column: string) {
  return normalizeIdentifierToken(column).toUpperCase()
}

function splitQualifiedIdentifier(value: string) {
  const parts: string[] = []
  let current = ""
  let inQuote = false
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!
    if (ch === '"') {
      current += ch
      if (inQuote && value[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuote = !inQuote
      }
      continue
    }
    if (ch === "." && !inQuote) {
      if (current.trim()) parts.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseColumnCommentsFromDdl(ddl: string, owner: string, table: string) {
  const map = new Map<string, string>()
  const lineRegex = /^\s*COMMENT\s+ON\s+COLUMN\s+(.+?)\s+IS\s+'((?:''|[^'])*)'\s*;?\s*$/i
  const ownerUpper = owner.toUpperCase()
  const tableUpper = table.toUpperCase()
  for (const rawLine of ddl.split(/\r?\n/)) {
    const match = rawLine.match(lineRegex)
    if (!match) continue
    const targetRaw = match[1] ?? ""
    const commentRaw = (match[2] ?? "").replaceAll("''", "'").trim()
    if (!commentRaw) continue
    const parts = splitQualifiedIdentifier(targetRaw).map((part) => normalizeIdentifierToken(part))
    if (parts.length < 2) continue
    const column = parts[parts.length - 1]!.trim()
    const tableName = parts[parts.length - 2]!.trim()
    const ownerName = parts.length >= 3 ? parts[parts.length - 3]!.trim() : ""
    if (!column || !tableName) continue
    if (tableName.toUpperCase() !== tableUpper) continue
    if (ownerName && ownerName.toUpperCase() !== ownerUpper) continue
    map.set(column.toUpperCase(), commentRaw)
  }
  return map
}

function parseMysqlColumnCommentsFromDdl(ddl: string, table: string) {
  const map = new Map<string, string>()
  const tableUpper = table.toUpperCase()
  const tableMatch = /^\s*CREATE\s+TABLE\s+(.+?)\s*\(/im.exec(ddl)
  if (!tableMatch) return map
  const tableParts = splitQualifiedIdentifier(tableMatch[1] ?? "").map((part) => normalizeIdentifierToken(part))
  const tableName = tableParts[tableParts.length - 1]?.trim().toUpperCase()
  if (!tableName || tableName !== tableUpper) return map

  const lineRegex = /^\s*`([^`]+)`\s+.+?(?:\s+COMMENT\s+'((?:\\'|''|[^'])*)')?\s*,?\s*$/i
  for (const rawLine of ddl.split(/\r?\n/)) {
    const match = rawLine.match(lineRegex)
    if (!match) continue
    const column = String(match[1] ?? "").trim()
    const commentRaw = String(match[2] ?? "")
      .replaceAll("\\'", "'")
      .replaceAll("''", "'")
      .trim()
    if (!column || !commentRaw) continue
    map.set(column.toUpperCase(), commentRaw)
  }
  return map
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function defaultForm(driver: DriverKind): ConnectionForm {
  if (driver === "mysql") {
    return {
      host: "127.0.0.1",
      port: "3306",
      database: "",
      schema: "",
      username: "",
      password: "",
      connectString: "",
    }
  }
  return {
    host: "127.0.0.1",
    port: "5236",
    database: "",
    schema: "",
    username: "",
    password: "",
    connectString: "",
  }
}

function createSavedConnection(index: number, driver: DriverKind): SavedConnection {
  return {
    id: createId(),
    name: `数据库 ${index}`,
    driver,
    objects: [],
    objectsLoaded: false,
    ...defaultForm(driver),
  }
}

export function getDatabaseBootstrapPatch(
  state: DatabaseBootstrapState,
  ready: boolean,
  createDefaultConnection: () => SavedConnection,
): DatabaseBootstrapPatch | undefined {
  if (!ready) return

  if (state.connections.length === 0) {
    const next = createDefaultConnection()
    return {
      connections: [next],
      activeConnectionID: next.id,
      connectedConnectionID: "",
    }
  }

  const known = new Set(state.connections.map((item) => item.id))
  const patch: DatabaseBootstrapPatch = {}

  if (!state.activeConnectionID || !known.has(state.activeConnectionID)) {
    patch.activeConnectionID = state.connections[0]!.id
  }

  if (state.connectedConnectionID && !known.has(state.connectedConnectionID)) {
    patch.connectedConnectionID = ""
  }

  return Object.keys(patch).length > 0 ? patch : undefined
}

function buildTree(
  database: string,
  rows: Array<{ schema: string; table: string; comment?: string }>,
  columnsByTable?: Map<string, Array<{ name: string; comment?: string }>>,
) {
  const map = new Map<string, TableTreeNode[]>()
  for (const row of rows) {
    const schema = (row.schema || "default").trim() || "default"
    const table = row.table.trim()
    if (!table) continue
    const list = map.get(schema) ?? []
    list.push({
      name: table,
      comment: row.comment?.trim() || undefined,
      columns: columnsByTable?.get(objectKey(schema, table)) ?? [],
    })
    map.set(schema, list)
  }
  const schemas: SchemaTreeNode[] = [...map.entries()].map(([name, tables]) => ({
    name,
    tables: [...tables]
      .reduce<TableTreeNode[]>((acc, item) => {
        const existing = acc.find((entry) => entry.name === item.name)
        if (!existing) {
          acc.push(item)
          return acc
        }
        if (!existing.comment && item.comment) existing.comment = item.comment
        return acc
      }, [])
      .sort((a, b) => a.name.localeCompare(b.name)),
  }))
  schemas.sort((a, b) => a.name.localeCompare(b.name))
  return [
    {
      name: database || "database",
      schemas,
    },
  ] as DatabaseTreeNode[]
}

export const { use: useDatabase, provider: DatabaseProvider } = createSimpleContext({
  name: "Database",
  init: () => {
    const sdk = useSDK()
    const server = useServer()

    const defaults = {
      connections: [createSavedConnection(1, "mysql")] as SavedConnection[],
      activeConnectionID: "",
      connectedConnectionID: "",
      running: false,
      connecting: false,
      loadingTables: false,
      sql: DEFAULT_SQL,
      message: "未连接数据库",
      result: undefined as QueryResult | undefined,
      history: [] as QueryResult[],
    }

    const [store, setStore, _, ready] = persisted(Persist.global("database.v3", ["database.v2"]), createStore(defaults))

    createEffect(() => {
      const patch = getDatabaseBootstrapPatch(
        {
          connections: store.connections,
          activeConnectionID: store.activeConnectionID,
          connectedConnectionID: store.connectedConnectionID,
        },
        ready(),
        () => createSavedConnection(1, "mysql"),
      )
      if (!patch) return

      batch(() => {
        if (patch.connections) setStore("connections", patch.connections)
        if (patch.activeConnectionID !== undefined) setStore("activeConnectionID", patch.activeConnectionID)
        if (patch.connectedConnectionID !== undefined) setStore("connectedConnectionID", patch.connectedConnectionID)
      })
    })

    const activeConnection = createMemo(() => store.connections.find((item) => item.id === store.activeConnectionID))
    const activeConnected = createMemo(() => !!activeConnection() && store.connectedConnectionID === activeConnection()!.id)

    const authHeader = () => {
      const current = server.current
      if (!current?.http.password) return undefined
      const username = current.http.username ?? "opencode"
      return `Basic ${base64Utf8(`${username}:${current.http.password}`)}`
    }

    const queryEndpoint = () => {
      const url = new URL("/database/query", sdk.url)
      url.searchParams.set("directory", sdk.directory)
      return url
    }

    const requestQuery = async (connection: SavedConnection, sql: string, limit?: number) => {
      const port = Number.parseInt(connection.port, 10)
      const payload = {
        driver: connection.driver,
        sql,
        limit,
        connection: {
          host: connection.host.trim() || undefined,
          port: Number.isFinite(port) && port > 0 ? port : undefined,
          database: connection.database.trim() || undefined,
          schema: connection.schema.trim() || undefined,
          username: connection.username.trim() || undefined,
          password: connection.password,
          connectString: connection.connectString.trim() || undefined,
        },
      }

      const auth = authHeader()
      const response = await fetch(queryEndpoint().toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": encodeURIComponent(sdk.directory),
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const parsedMessage = parseServerErrorText(text, "Database request failed")
        throw new Error(parsedMessage)
        throw new Error(text || "数据库请求失败")
      }

      const body = (await response.json()) as QueryResponse
      const columns = Array.isArray(body.columns) ? body.columns.map((column) => String(column)) : []
      const rowsRaw = Array.isArray(body.rows) ? body.rows : []
      const rows = rowsRaw.map((row) => (Array.isArray(row) ? row : [row])) as unknown[][]

      return {
        columns,
        rows: normalizeRows(rows),
        affectedRows: Math.max(0, Number(body.affectedRows ?? 0)),
      }
    }

    const addResult = (result: QueryResult) => {
      setStore("result", result)
      setStore("history", (history) => [result, ...history].slice(0, 30))
    }

    const resolveDatabaseName = (connection: SavedConnection) => {
      if (connection.driver === "dameng") {
        return connection.database.trim() || connection.name.trim() || "DAMENG"
      }
      return connection.database.trim() || connection.name.trim() || "MySQL"
    }

    const resolveColumnComments = (connection: SavedConnection, sql: string, columns: string[]) => {
      const tableRef = resolveSingleFromTable(sql)
      if (!tableRef) return undefined
      const objects = connection.objects ?? []
      let foundColumns: Array<{ name: string; comment?: string }> | undefined
      const targetTable = tableRef.table.toUpperCase()
      const targetSchema = tableRef.schema?.toUpperCase()
      for (const dbNode of objects) {
        for (const schemaNode of dbNode.schemas ?? []) {
          if (targetSchema && schemaNode.name.toUpperCase() !== targetSchema) continue
          for (const tableNode of schemaNode.tables ?? []) {
            const tableName = tableNode.name.toUpperCase()
            if (tableName !== targetTable) continue
            const normalized = (tableNode.columns ?? []).map((column) =>
              typeof column === "string" ? { name: column } : column,
            )
            foundColumns = normalized
            break
          }
          if (foundColumns) break
        }
        if (foundColumns) break
      }
      if (!foundColumns || foundColumns.length === 0) return undefined
      const commentMap = new Map(foundColumns.map((item) => [normalizeColumnName(item.name), item.comment ?? ""]))
      const comments = columns.map((column) => commentMap.get(normalizeColumnName(column)) ?? "")
      return comments.some((item) => item) ? comments : undefined
    }

    const loadObjects = async () => {
      const connection = activeConnection()
      if (!connection) return
      setStore("loadingTables", true)
      try {
        if (connection.driver === "mysql") {
          const result = await requestQuery(
            connection,
            "SELECT table_schema, table_name, table_comment FROM information_schema.tables WHERE table_type = 'BASE TABLE' ORDER BY table_schema, table_name",
            5000,
          )
          const rows = result.rows
            .map((row) => ({
              schema: String(row[0] ?? ""),
              table: String(row[1] ?? ""),
              comment: String(row[2] ?? ""),
            }))
            .filter((row) => row.table)
          const databaseFilter = connection.database.trim()
          const whereClause = databaseFilter ? ` WHERE table_schema = ${quoteSqlLiteral(databaseFilter)}` : ""
          const columnsResult = await requestQuery(
            connection,
            `SELECT table_schema, table_name, column_name, column_comment FROM information_schema.columns${whereClause} ORDER BY table_schema, table_name, ordinal_position`,
          )
          const columnsByTable = new Map<string, Array<{ name: string; comment?: string }>>()
          for (const row of columnsResult.rows) {
            addColumnToMap(
              columnsByTable,
              String(row[0] ?? ""),
              String(row[1] ?? ""),
              String(row[2] ?? ""),
              String(row[3] ?? ""),
            )
          }
          const tree = buildTree(resolveDatabaseName(connection), rows, columnsByTable)
          setStore("connections", (item) => item.id === connection.id, "objects", tree)
          setStore("connections", (item) => item.id === connection.id, "objectsLoaded", true)
          return
        }

        let rows: Array<{ schema: string; table: string; comment?: string }> = []
        const columnsByTable = new Map<string, Array<{ name: string; comment?: string }>>()
        try {
          const schemaFilter = connection.schema.trim().toUpperCase()
          const whereClause = schemaFilter ? ` WHERE t.owner = ${quoteSqlLiteral(schemaFilter)}` : ""
          const result = await requestQuery(
            connection,
            `SELECT t.owner, t.table_name, c.comments FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name${whereClause} ORDER BY t.owner, t.table_name`,
            5000,
          )
          rows = result.rows
            .map((row) => ({
              schema: String(row[0] ?? ""),
              table: String(row[1] ?? ""),
              comment: String(row[2] ?? ""),
            }))
            .filter((row) => row.table)

          const columnsResult = await requestQuery(
            connection,
            `SELECT c.owner, c.table_name, c.column_name FROM all_tab_columns c${whereClause.replace("t.owner", "c.owner")} ORDER BY c.owner, c.table_name, c.column_id`,
          )
          for (const row of columnsResult.rows) {
            addColumnToMap(
              columnsByTable,
              String(row[0] ?? ""),
              String(row[1] ?? ""),
              String(row[2] ?? ""),
            )
          }
          try {
            const commentsResult = await requestQuery(
              connection,
              `SELECT cc.owner, cc.table_name, cc.column_name, cc.comments FROM all_col_comments cc${whereClause.replace("t.owner", "cc.owner")} ORDER BY cc.owner, cc.table_name, cc.column_name`,
            )
            for (const row of commentsResult.rows) {
              addColumnToMap(
                columnsByTable,
                String(row[0] ?? ""),
                String(row[1] ?? ""),
                String(row[2] ?? ""),
                String(row[3] ?? ""),
              )
            }
          } catch {}
        } catch {
          const fallback = await requestQuery(
            connection,
            "SELECT t.table_name, c.comments FROM user_tables t LEFT JOIN user_tab_comments c ON c.table_name = t.table_name ORDER BY t.table_name",
            5000,
          )
          const schema = connection.schema.trim() || connection.username.trim() || "CURRENT_SCHEMA"
          rows = fallback.rows
            .map((row) => ({
              table: String(row[0] ?? ""),
              comment: String(row[1] ?? ""),
            }))
            .filter((row) => row.table)
            .map((row) => ({
              schema,
              table: row.table,
              comment: row.comment,
            }))

          const columnsFallback = await requestQuery(
            connection,
            "SELECT c.table_name, c.column_name FROM user_tab_columns c ORDER BY c.table_name, c.column_id",
          )
          for (const row of columnsFallback.rows) {
            addColumnToMap(
              columnsByTable,
              schema,
              String(row[0] ?? ""),
              String(row[1] ?? ""),
            )
          }
          try {
            const commentsFallback = await requestQuery(
              connection,
              "SELECT c.table_name, c.column_name, c.comments FROM user_col_comments c ORDER BY c.table_name, c.column_name",
            )
            for (const row of commentsFallback.rows) {
              addColumnToMap(
                columnsByTable,
                schema,
                String(row[0] ?? ""),
                String(row[1] ?? ""),
                String(row[2] ?? ""),
              )
            }
          } catch {}
        }
        const tree = buildTree(resolveDatabaseName(connection), rows, columnsByTable)
        setStore("connections", (item) => item.id === connection.id, "objects", tree)
        setStore("connections", (item) => item.id === connection.id, "objectsLoaded", true)
      } catch (error) {
        setStore("message", `加载数据库对象失败：${errorMessage(error, "未知错误")}`)
      } finally {
        setStore("loadingTables", false)
      }
    }

    const ensureColumnsForSql = async (sql: string) => {
      const connection = activeConnection()
      if (!connection) return
      const tableRef = resolveSingleFromTable(sql)
      if (!tableRef) return
      const targetTable = tableRef.table.trim()
      if (!targetTable) return
      const targetSchema = (tableRef.schema?.trim() || connection.schema.trim() || connection.username.trim() || "").toUpperCase()

      const current = activeConnection()
      const existing = current?.objects
        .flatMap((dbNode) => dbNode.schemas ?? [])
        .filter((schemaNode) => (!targetSchema ? true : schemaNode.name.toUpperCase() === targetSchema))
        .flatMap((schemaNode) => schemaNode.tables ?? [])
        .find((tableNode) => tableNode.name.toUpperCase() === targetTable.toUpperCase())
      if (existing?.columns && existing.columns.length > 0) {
        const hasAnyComment = existing.columns.some((column) => !!column.comment?.trim())
        if (hasAnyComment) return
      }

      const rows: Array<{ name: string; comment?: string }> = []
      try {
        if (connection.driver === "mysql") {
          const schema = tableRef.schema?.trim() || connection.database.trim()
          if (!schema) return
          const result = await requestQuery(
            connection,
            `SELECT column_name, column_comment FROM information_schema.columns WHERE table_schema = ${quoteSqlLiteral(schema)} AND table_name = ${quoteSqlLiteral(targetTable)} ORDER BY ordinal_position`,
          )
          for (const row of result.rows) {
            const name = String(row[0] ?? "").trim()
            if (!name) continue
            rows.push({ name, comment: String(row[1] ?? "").trim() || undefined })
          }
        } else {
          const owner = (tableRef.schema?.trim() || connection.schema.trim() || connection.username.trim()).toUpperCase()
          const tableName = targetTable.toUpperCase()
          if (!owner) return
          const names = await requestQuery(
            connection,
            `SELECT c.column_name FROM all_tab_columns c WHERE c.owner = ${quoteSqlLiteral(owner)} AND c.table_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_id`,
          )
          for (const row of names.rows) {
            const name = String(row[0] ?? "").trim()
            if (!name) continue
            rows.push({ name })
          }
          const commentMap = new Map<string, string>()
          const commentSqlCandidates = [
            `SELECT c.column_name, c.comments FROM all_col_comments c WHERE c.owner = ${quoteSqlLiteral(owner)} AND c.table_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_name`,
            `SELECT c.column_name, c.comments FROM all_col_comments c WHERE c.schema_name = ${quoteSqlLiteral(owner)} AND c.table_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_name`,
            `SELECT c.column_name, c.comments FROM all_col_comments c WHERE c.owner = ${quoteSqlLiteral(owner)} AND c.object_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_name`,
            `SELECT c.column_name, c.comments FROM all_col_comments c WHERE c.schema_name = ${quoteSqlLiteral(owner)} AND c.object_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_name`,
            `SELECT c.column_name, c.comments FROM user_col_comments c WHERE c.table_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_name`,
            `SELECT c.column_name, c.comments FROM user_col_comments c WHERE c.object_name = ${quoteSqlLiteral(tableName)} ORDER BY c.column_name`,
          ]
          for (const candidate of commentSqlCandidates) {
            try {
              const comments = await requestQuery(connection, candidate)
              let added = 0
              for (const row of comments.rows) {
                const column = String(row[0] ?? "").trim().toUpperCase()
                const comment = String(row[1] ?? "").trim()
                if (!column || !comment || commentMap.has(column)) continue
                commentMap.set(column, comment)
                added += 1
              }
              if (added > 0) break
            } catch {}
          }

          if (commentMap.size === 0) {
            try {
              const ddl = await requestQuery(
                connection,
                `SELECT DBMS_METADATA.GET_DDL('TABLE', ${quoteSqlLiteral(tableName)}, ${quoteSqlLiteral(owner)}) FROM dual`,
                1,
              )
              const ddlText = String(ddl.rows[0]?.[0] ?? "")
              const ddlComments = parseColumnCommentsFromDdl(ddlText, owner, tableName)
              for (const [column, comment] of ddlComments.entries()) {
                if (!commentMap.has(column)) commentMap.set(column, comment)
              }
            } catch {}
          }

          for (const row of rows) {
            const comment = commentMap.get(row.name.toUpperCase())
            if (comment) row.comment = comment
          }
        }
      } catch {
        return
      }

      if (rows.length === 0) return

      setStore("connections", (item) => item.id === connection.id, "objects", (objects) =>
        objects.map((dbNode) => ({
          ...dbNode,
          schemas: (dbNode.schemas ?? []).map((schemaNode) => {
            const schemaMatch = !targetSchema || schemaNode.name.toUpperCase() === targetSchema
            if (!schemaMatch) return schemaNode
            return {
              ...schemaNode,
              tables: (schemaNode.tables ?? []).map((tableNode) =>
                tableNode.name.toUpperCase() === targetTable.toUpperCase()
                  ? {
                      ...tableNode,
                      columns: rows,
                    }
                  : tableNode,
              ),
            }
          }),
        })),
      )

    }

    const executeSql = async (
      sql: string,
      meta?: {
        source?: "panel" | "file"
        filePath?: string
        preserveEditorSql?: boolean
      },
    ) => {
      const connection = activeConnection()
      if (!connection) {
        setStore("message", "请先创建并选择数据库连接")
        return undefined
      }
      const text = sql.trim()
      if (!text) return undefined
      const start = performance.now()
      setStore("running", true)
      setStore("result", undefined)
      if (!meta?.preserveEditorSql) setStore("sql", text)
      try {
        const result = await requestQuery(connection, text)
        let columnComments = resolveColumnComments(connection, text, result.columns)
        if (!columnComments || !columnComments.some((item) => !!item?.trim())) {
          await ensureColumnsForSql(text)
          const refreshed = activeConnection()
          if (refreshed) {
            columnComments = resolveColumnComments(refreshed, text, result.columns)
          }
        }
        const next: QueryResult = {
          id: createId(),
          sql: text,
          columns: result.columns,
          columnComments,
          rows: result.rows,
          affectedRows: result.affectedRows,
          durationMs: Math.max(1, Math.round(performance.now() - start)),
          timestamp: Date.now(),
          source: meta?.source ?? "panel",
          filePath: meta?.filePath,
        }
        addResult(next)
        setStore("connectedConnectionID", connection.id)
        setStore("message", `执行成功，用时 ${next.durationMs} ms`)
        return next
      } catch (error) {
        const next: QueryResult = {
          id: createId(),
          sql: text,
          columns: [],
          rows: [],
          affectedRows: 0,
          durationMs: Math.max(1, Math.round(performance.now() - start)),
          timestamp: Date.now(),
          source: meta?.source ?? "panel",
          filePath: meta?.filePath,
          error: errorMessage(error, "执行失败"),
        }
        addResult(next)
        setStore("message", `执行失败：${next.error}`)
        return next
      } finally {
        setStore("running", false)
      }
    }

    const pickTable = (table: string, schema?: string) => {
      const connection = activeConnection()
      if (!connection) return
      const tableName = table.trim()
      if (!tableName) return
      if (connection.driver === "mysql") {
        if (schema) {
          setStore("sql", `SELECT * FROM \`${schema}\`.\`${tableName}\` LIMIT 200;`)
          return
        }
        setStore("sql", `SELECT * FROM \`${tableName}\` LIMIT 200;`)
        return
      }
      const target = schema?.trim()
        ? `${quoteDamengIdentifier(schema)}.${quoteDamengIdentifier(tableName)}`
        : quoteDamengIdentifier(tableName)
      setStore("sql", `SELECT * FROM ${target} FETCH FIRST 200 ROWS ONLY;`)
    }

    const loadCreateTableSql = async (table: string, schema?: string) => {
      const connection = activeConnection()
      if (!connection) return
      const tableName = table.trim()
      if (!tableName) return
      try {
        if (connection.driver === "mysql") {
          const sql = schema?.trim()
            ? `SHOW CREATE TABLE \`${schema.trim()}\`.\`${tableName}\``
            : `SHOW CREATE TABLE \`${tableName}\``
          const result = await requestQuery(connection, sql, 1)
          const ddl = result.rows[0]?.[1] ?? result.rows[0]?.[0]
          if (!ddl) throw new Error("未获取到建表语句")
          const ddlText = String(ddl)
          const schemaName = (schema?.trim() || connection.database.trim()).toUpperCase()
          const object = tableName.toUpperCase()
          const ddlComments = parseMysqlColumnCommentsFromDdl(ddlText, object)
          if (ddlComments.size > 0 && schemaName) {
            setStore("connections", (item) => item.id === connection.id, "objects", (objects) =>
              objects.map((dbNode) => ({
                ...dbNode,
                schemas: (dbNode.schemas ?? []).map((schemaNode) => {
                  if (schemaNode.name.toUpperCase() !== schemaName) return schemaNode
                  return {
                    ...schemaNode,
                    tables: (schemaNode.tables ?? []).map((tableNode) => {
                      if (tableNode.name.toUpperCase() !== object) return tableNode
                      const existing = (tableNode.columns ?? []).map((column) =>
                        typeof column === "string" ? { name: column } : { ...column },
                      )
                      const indexMap = new Map(existing.map((column, index) => [column.name.toUpperCase(), index]))
                      for (const [columnUpper, comment] of ddlComments.entries()) {
                        const idx = indexMap.get(columnUpper)
                        if (idx == null) {
                          existing.push({ name: columnUpper, comment })
                          continue
                        }
                        existing[idx] = { ...existing[idx]!, comment: existing[idx]!.comment || comment }
                      }
                      return {
                        ...tableNode,
                        columns: existing,
                      }
                    }),
                  }
                }),
              })),
            )
          }
          setStore("sql", ddlText)
          setStore("message", `已加载 ${tableName} 的建表语句`)
          return
        }

        const owner = (schema?.trim() || connection.schema.trim() || connection.username.trim()).toUpperCase()
        const object = tableName.toUpperCase()
        const sql = `SELECT DBMS_METADATA.GET_DDL('TABLE', ${quoteSqlLiteral(object)}, ${quoteSqlLiteral(owner)}) FROM dual`
        const result = await requestQuery(connection, sql, 1)
        const ddl = result.rows[0]?.[0]
        if (!ddl) throw new Error("未获取到建表语句")
        const tableRef = `${quoteDamengIdentifier(owner)}.${quoteDamengIdentifier(object)}`
        const commentLines: string[] = []
        try {
          const tableCommentResult = await requestQuery(
            connection,
            `SELECT comments FROM all_tab_comments WHERE owner = ${quoteSqlLiteral(owner)} AND table_name = ${quoteSqlLiteral(object)}`,
            1,
          )
          const tableComment = String(tableCommentResult.rows[0]?.[0] ?? "").trim()
          if (tableComment) {
            commentLines.push(`COMMENT ON TABLE ${tableRef} IS ${quoteSqlLiteral(tableComment)};`)
          }

          const columnCommentResult = await requestQuery(
            connection,
            `SELECT c.column_name, cc.comments FROM all_tab_columns c LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name WHERE c.owner = ${quoteSqlLiteral(owner)} AND c.table_name = ${quoteSqlLiteral(object)} ORDER BY c.column_id`,
          )
          for (const row of columnCommentResult.rows) {
            const column = String(row[0] ?? "").trim()
            const comment = String(row[1] ?? "").trim()
            if (!column || !comment) continue
            commentLines.push(
              `COMMENT ON COLUMN ${tableRef}.${quoteDamengIdentifier(column)} IS ${quoteSqlLiteral(comment)};`,
            )
          }
        } catch {
          try {
            const tableCommentResult = await requestQuery(
              connection,
              `SELECT comments FROM user_tab_comments WHERE table_name = ${quoteSqlLiteral(object)}`,
              1,
            )
            const tableComment = String(tableCommentResult.rows[0]?.[0] ?? "").trim()
            if (tableComment) {
              commentLines.push(`COMMENT ON TABLE ${tableRef} IS ${quoteSqlLiteral(tableComment)};`)
            }

            const columnCommentResult = await requestQuery(
              connection,
              `SELECT c.column_name, cc.comments FROM user_tab_columns c LEFT JOIN user_col_comments cc ON cc.table_name = c.table_name AND cc.column_name = c.column_name WHERE c.table_name = ${quoteSqlLiteral(object)} ORDER BY c.column_id`,
            )
            for (const row of columnCommentResult.rows) {
              const column = String(row[0] ?? "").trim()
              const comment = String(row[1] ?? "").trim()
              if (!column || !comment) continue
              commentLines.push(
                `COMMENT ON COLUMN ${tableRef}.${quoteDamengIdentifier(column)} IS ${quoteSqlLiteral(comment)};`,
              )
            }
          } catch {}
        }

        if (!commentLines.some((line) => line.startsWith("COMMENT ON COLUMN "))) {
          const seen = new Set<string>()
          const commentSqlCandidates = [
            `SELECT column_name, comments FROM all_col_comments WHERE owner = ${quoteSqlLiteral(owner)} AND table_name = ${quoteSqlLiteral(object)}`,
            `SELECT column_name, comments FROM all_col_comments WHERE schema_name = ${quoteSqlLiteral(owner)} AND table_name = ${quoteSqlLiteral(object)}`,
            `SELECT column_name, comments FROM all_col_comments WHERE owner = ${quoteSqlLiteral(owner)} AND object_name = ${quoteSqlLiteral(object)}`,
            `SELECT column_name, comments FROM all_col_comments WHERE schema_name = ${quoteSqlLiteral(owner)} AND object_name = ${quoteSqlLiteral(object)}`,
            `SELECT column_name, comments FROM user_col_comments WHERE table_name = ${quoteSqlLiteral(object)}`,
            `SELECT column_name, comments FROM user_col_comments WHERE object_name = ${quoteSqlLiteral(object)}`,
          ]
          for (const candidate of commentSqlCandidates) {
            try {
              const result = await requestQuery(connection, candidate)
              for (const row of result.rows) {
                const column = String(row[0] ?? "").trim()
                const comment = String(row[1] ?? "").trim()
                if (!column || !comment) continue
                if (seen.has(column.toUpperCase())) continue
                seen.add(column.toUpperCase())
                commentLines.push(
                  `COMMENT ON COLUMN ${tableRef}.${quoteDamengIdentifier(column)} IS ${quoteSqlLiteral(comment)};`,
                )
              }
              if (seen.size > 0) break
            } catch {}
          }
        }

        const finalDdl = commentLines.length > 0 ? `${String(ddl).trim()}\n\n${commentLines.join("\n")}` : String(ddl)
        const ddlComments = parseColumnCommentsFromDdl(finalDdl, owner, object)
        if (ddlComments.size > 0) {
          setStore("connections", (item) => item.id === connection.id, "objects", (objects) =>
            objects.map((dbNode) => ({
              ...dbNode,
              schemas: (dbNode.schemas ?? []).map((schemaNode) => {
                if (schemaNode.name.toUpperCase() !== owner) return schemaNode
                return {
                  ...schemaNode,
                  tables: (schemaNode.tables ?? []).map((tableNode) => {
                    if (tableNode.name.toUpperCase() !== object) return tableNode
                    const existing = (tableNode.columns ?? []).map((column) =>
                      typeof column === "string" ? { name: column } : { ...column },
                    )
                    const indexMap = new Map(existing.map((column, index) => [column.name.toUpperCase(), index]))
                    for (const [columnUpper, comment] of ddlComments.entries()) {
                      const idx = indexMap.get(columnUpper)
                      if (idx == null) {
                        existing.push({ name: columnUpper, comment })
                        continue
                      }
                      existing[idx] = { ...existing[idx]!, comment: existing[idx]!.comment || comment }
                    }
                    return {
                      ...tableNode,
                      columns: existing,
                    }
                  }),
                }
              }),
            })),
          )
        }
        setStore("sql", finalDdl)
        setStore("message", `已加载 ${tableName} 的建表语句`)
      } catch (error) {
        const message = errorMessage(error, "获取建表语句失败")
        setStore(
          "sql",
          [
            `-- 获取表 ${tableName} 的建表语句失败`,
            `-- ${message}`,
            "-- 对于达梦，请确认当前账号具备 DBMS_METADATA 权限后重试。",
          ].join("\n"),
        )
        setStore("message", `获取建表语句失败：${message}`)
      }
    }

    return {
      state: {
        connections: createMemo(() => store.connections),
        activeConnectionID: createMemo(() => store.activeConnectionID),
        activeConnection,
        connected: activeConnected,
        running: createMemo(() => store.running),
        connecting: createMemo(() => store.connecting),
        loadingTables: createMemo(() => store.loadingTables),
        sql: createMemo(() => store.sql),
        message: createMemo(() => store.message),
        result: createMemo(() => store.result),
        history: createMemo(() => store.history),
      },
      setActiveConnection(id: string) {
        setStore("activeConnectionID", id)
      },
      addConnection(driver: DriverKind = "mysql") {
        const next = createSavedConnection(store.connections.length + 1, driver)
        setStore("connections", (list) => [...list, next])
        setStore("activeConnectionID", next.id)
        setStore("connectedConnectionID", "")
      },
      removeConnection(id: string) {
        if (store.connections.length <= 1) return
        const nextList = store.connections.filter((item) => item.id !== id)
        setStore("connections", nextList)
        if (store.activeConnectionID === id) setStore("activeConnectionID", nextList[0]?.id ?? "")
        if (store.connectedConnectionID === id) setStore("connectedConnectionID", "")
      },
      renameActiveConnection(name: string) {
        const connection = activeConnection()
        if (!connection) return
        setStore("connections", (item) => item.id === connection.id, "name", name)
      },
      setActiveField(field: keyof ConnectionForm, value: string) {
        const connection = activeConnection()
        if (!connection) return
        setStore("connections", (item) => item.id === connection.id, field, value)
        setStore("connections", (item) => item.id === connection.id, "objectsLoaded", false)
        setStore("connectedConnectionID", "")
      },
      setActiveDriver(driver: DriverKind) {
        const connection = activeConnection()
        if (!connection) return
        const defaultsByDriver = defaultForm(driver)
        setStore("connections", (item) => item.id === connection.id, "driver", driver)
        setStore("connections", (item) => item.id === connection.id, "port", defaultsByDriver.port)
        setStore("connections", (item) => item.id === connection.id, "objectsLoaded", false)
        setStore("connectedConnectionID", "")
        setStore("message", `已切换到 ${driver === "mysql" ? "MySQL" : "达梦"} 驱动`)
      },
      setSql(sql: string) {
        setStore("sql", sql)
      },
      clearHistory() {
        setStore("history", [])
        setStore("result", undefined)
      },
      async testConnection() {
        const connection = activeConnection()
        if (!connection) return
        setStore("connecting", true)
        try {
          await requestQuery(connection, "SELECT 1;", 1)
          setStore("connectedConnectionID", connection.id)
          setStore("message", "连接测试成功")
          await loadObjects()
        } catch (error) {
          setStore("connectedConnectionID", "")
          setStore("message", `连接失败：${errorMessage(error, "连接失败")}`)
          throw error
        } finally {
          setStore("connecting", false)
        }
      },
      async refreshTables() {
        await loadObjects()
      },
      async ensureObjectsLoaded() {
        const connection = activeConnection()
        if (!connection) return
        if (connection.objectsLoaded) return
        await loadObjects()
      },
      async loadTableDDL(table: string, schema?: string) {
        await loadCreateTableSql(table, schema)
      },
      async ensureColumnsForSql(sql: string) {
        await ensureColumnsForSql(sql)
      },
      pickTable,
      async disconnect() {
        setStore("connectedConnectionID", "")
        setStore("message", "已断开连接")
      },
      async runSql(sql: string, meta?: { source?: "panel" | "file"; filePath?: string; preserveEditorSql?: boolean }) {
        return await executeSql(sql, meta)
      },
    }
  },
})
