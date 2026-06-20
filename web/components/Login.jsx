"use client";

import { useRef, useState } from "react";
import { login } from "@/lib/api";

export default function Login({ onSuccess }) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  function handleChange(e) {
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setPin(value);
    if (error) {
      setError(false);
      setStatus("");
    }
    if (value.length === 6) submit(value);
  }

  async function submit(value) {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(false);
    setStatus("Verifying…");
    try {
      await login(value);
      setStatus("Access granted.");
      onSuccess();
    } catch (err) {
      setError(true);
      setStatus(err.message || "Invalid PIN.");
      setPin("");
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  const cells = Array.from({ length: 6 }, (_, i) => ({
    filled: i < pin.length,
    active: i === pin.length && !busy,
  }));

  return (
    <main className="grid min-h-[100svh] place-items-center px-6 pt-safe pb-safe">
      <section className="w-full max-w-[420px]">
        <div className="rounded-[3px] border border-line bg-bg-soft p-9 text-center shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
          <h1 className="font-display text-[clamp(2.2rem,8vw,3rem)] uppercase leading-[0.95] tracking-tight text-ink">
            Peek Remote
          </h1>
          <p className="mb-8 mt-4 font-mono text-[0.66rem] uppercase tracking-stamp text-faint">
            6-digit PIN
          </p>

          <div className="relative" onClick={() => inputRef.current?.focus()}>
            <input
              ref={inputRef}
              value={pin}
              onChange={handleChange}
              inputMode="numeric"
              autoComplete="one-time-code"
              type="tel"
              maxLength={6}
              autoFocus
              disabled={busy}
              aria-label="Access PIN"
              className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            />
            <div className="grid grid-cols-6 gap-2 sm:gap-2.5">
              {cells.map((c, i) => (
                <div
                  key={i}
                  className={`grid aspect-[3/4] place-items-center rounded-[2px] border transition-colors ${
                    c.active
                      ? "border-ink bg-white/[0.04]"
                      : c.filled
                        ? "border-line-strong"
                        : "border-line"
                  }`}
                >
                  {c.filled ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                  ) : c.active ? (
                    <span className="h-5 w-px bg-muted" />
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={() => submit(pin)}
            disabled={busy || pin.length !== 6}
            className="btn-primary mt-7 w-full disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Verifying…" : "Enter"}
          </button>

          <p
            className={`mt-3.5 min-h-[1.2rem] font-mono text-[0.68rem] uppercase tracking-stamp ${
              error ? "text-danger" : "text-muted"
            }`}
            role="status"
          >
            {status}
          </p>
        </div>
      </section>
    </main>
  );
}
