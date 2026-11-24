/**
 * Limitador de taxa em memória (janela deslizante simples).
 * Protege contra spam de comandos/botões. Estado é volátil por design.
 */
export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /** Retorna { ok, retryAfterMs }. Registra a tentativa quando permitida. */
  check(key) {
    const t = this.now();
    const recent = (this.hits.get(key) || []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (t - recent[0]) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true, retryAfterMs: 0 };
  }

  sweep() {
    const t = this.now();
    for (const [key, list] of this.hits) {
      const recent = list.filter((ts) => t - ts < this.windowMs);
      if (recent.length) this.hits.set(key, recent);
      else this.hits.delete(key);
    }
  }
}
