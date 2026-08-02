import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_BYTES = 1024 * 1024;
const SECRET_KEYS = /token|access|refresh|authorization|cookie|secret|prompt|content/i;

export const redact = (value: unknown, key = ""): unknown => {
  if (SECRET_KEYS.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
};

export class RelayLog {
  private failed = false;
  constructor(readonly path: string, private readonly maxBytes = MAX_BYTES) {}

  async write(event: string, data: Record<string, unknown> = {}): Promise<void> {
    if (this.failed) return;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      if ((await stat(this.path).catch(() => undefined))?.size && (await stat(this.path)).size >= this.maxBytes) await this.rotate();
      await appendFile(this.path, `${JSON.stringify(redact({ ts: new Date().toISOString(), event, ...data }))}\n`, { mode: 0o600 });
      await chmod(this.path, 0o600);
    } catch { this.failed = true; }
  }

  private async rotate(): Promise<void> {
    await rename(`${this.path}.2`, `${this.path}.3`).catch(() => undefined);
    await rename(`${this.path}.1`, `${this.path}.2`).catch(() => undefined);
    await rename(this.path, `${this.path}.1`).catch(() => undefined);
  }
}
