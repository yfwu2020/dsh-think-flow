import type { IncomingMessage, ServerResponse } from 'node:http'

/** Error codes cross the service boundary; provider response bodies do not. */
export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * 读 JSON 请求体（有上限）。
 *
 * 只给 `/translate` 用：一段 ≤ 4000 字，60KB 的上限把"有人拿它当上传口"挡在外面。
 * 超限**继续把流读空**再拒绝（直接 destroy 会让浏览器看到连接被重置，拿不到 413）。
 */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) { tooLarge = true; chunks.length = 0; return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) { reject(Object.assign(new Error('body too large'), { status: 413, code: 'BODY_TOO_LARGE' })); return }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400, code: 'INVALID_JSON' }))
      }
    })
    req.on('error', (error) => { reject(error) })
  })
}

export function query(req: IncomingMessage, key: string): string | undefined {
  const url = req.url ?? ''
  const q = url.indexOf('?')
  if (q < 0) return undefined
  const params = new URLSearchParams(url.slice(q + 1))
  return params.get(key) ?? undefined
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}
