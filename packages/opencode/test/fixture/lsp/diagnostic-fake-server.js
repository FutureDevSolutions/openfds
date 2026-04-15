// Adversarial fake LSP server for testing waitForDiagnostics.
// Supports timed diagnostic publication via "test/publishDiagnostics" notification.
//
// Params for "test/publishDiagnostics":
//   uri      - file URI
//   diagnostics - array of diagnostic objects
//   delayMs  - optional delay before sending (default 0)
//
// Also supports "test/publishBurst" for burst scenarios:
//   uri         - file URI
//   count       - number of publishes
//   intervalMs  - interval between each
//   diagnostics - diagnostics to send in each burst

function encode(message) {
  const json = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`
  return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(json, "utf8")])
}

function decodeFrames(buffer) {
  const results = []
  let idx
  while ((idx = buffer.indexOf("\r\n\r\n")) !== -1) {
    const header = buffer.slice(0, idx).toString("utf8")
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    const len = m ? parseInt(m[1], 10) : 0
    const bodyStart = idx + 4
    const bodyEnd = bodyStart + len
    if (buffer.length < bodyEnd) break
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8")
    results.push(body)
    buffer = buffer.slice(bodyEnd)
  }
  return { messages: results, rest: buffer }
}

let readBuffer = Buffer.alloc(0)

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk])
  const { messages, rest } = decodeFrames(readBuffer)
  readBuffer = rest
  for (const m of messages) handle(m)
})

function send(msg) {
  process.stdout.write(encode(msg))
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params })
}

function handle(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  if (data.method === "initialize") {
    send({ jsonrpc: "2.0", id: data.id, result: { capabilities: {} } })
    return
  }
  if (data.method === "initialized") {
    return
  }
  if (data.method === "workspace/didChangeConfiguration") {
    return
  }

  // Publish diagnostics for a single file with optional delay
  if (data.method === "test/publishDiagnostics") {
    const { uri, diagnostics, delayMs } = data.params || {}
    const doPublish = () => {
      sendNotification("textDocument/publishDiagnostics", {
        uri: uri || "file:///unknown",
        diagnostics: diagnostics || [],
      })
    }
    if (delayMs && delayMs > 0) {
      setTimeout(doPublish, delayMs)
    } else {
      doPublish()
    }
    return
  }

  // Publish a burst of diagnostics at intervals
  if (data.method === "test/publishBurst") {
    const { uri, count, intervalMs, diagnostics } = data.params || {}
    let sent = 0
    const fire = () => {
      if (sent >= (count || 1)) return
      sendNotification("textDocument/publishDiagnostics", {
        uri: uri || "file:///unknown",
        diagnostics: diagnostics || [],
      })
      sent++
      if (sent < (count || 1)) {
        setTimeout(fire, intervalMs || 10)
      }
    }
    fire()
    return
  }

  // Handle didOpen/didChange/didChangeWatchedFiles (ignore them, like a real server would initially)
  if (
    data.method === "textDocument/didOpen" ||
    data.method === "textDocument/didChange" ||
    data.method === "workspace/didChangeWatchedFiles"
  ) {
    return
  }

  // Respond OK to any request from client
  if (typeof data.id !== "undefined") {
    send({ jsonrpc: "2.0", id: data.id, result: null })
    return
  }
}
