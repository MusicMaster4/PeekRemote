"use client";

import { useCallback, useEffect, useState } from "react";
import { listSessions, revokeSession } from "@/lib/api";
import { IconUsers, IconClose, IconRefresh } from "@/components/icons";

const fmt = (v) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(v));

function deviceLabel(ua) {
  if (!ua) return "Unknown device";
  if (/iphone|ipad|ios/i.test(ua)) return "iPhone / iPad";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac/i.test(ua)) return "Mac";
  if (/linux/i.test(ua)) return "Linux";
  return ua.slice(0, 40);
}

export default function Sessions({ onClose, onLogout }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await listSessions());
    } catch (err) {
      if (err.unauthorized) return onLogout();
      setError(err.message);
    }
  }, [onLogout]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRevoke(s) {
    setBusyId(s.id);
    setError(null);
    try {
      const res = await revokeSession(s.id);
      if (res.revoked_self) return onLogout();
      await load();
    } catch (err) {
      if (err.unauthorized) return onLogout();
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="mb-[calc(0.75rem+env(safe-area-inset-bottom))] flex max-h-[85svh] w-[calc(100%-24px)] max-w-[480px] animate-rise flex-col self-end overflow-hidden rounded-[3px] border border-line-strong bg-panel-solid shadow-[0_30px_80px_rgba(0,0,0,0.6)] sm:mb-0 sm:self-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <IconUsers className="h-[18px] w-[18px] text-text" />
            <h3 className="font-display text-[1.15rem] uppercase tracking-tight text-ink">
              Active sessions
            </h3>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={load} className="icon-btn" title="Refresh" aria-label="Refresh">
              <IconRefresh className="h-[17px] w-[17px]" />
            </button>
            <button onClick={onClose} className="icon-btn" title="Close" aria-label="Close">
              <IconClose className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-2.5 overflow-y-auto px-5 py-4">
          <p className="font-mono text-[0.66rem] uppercase leading-relaxed tracking-stamp text-faint">
            You are the owner session. You can remove any other connected device.
          </p>

          {error && (
            <p className="rounded-[2px] border border-danger/40 bg-danger/10 px-3 py-2 text-[0.8rem] text-danger">
              {error}
            </p>
          )}

          {sessions === null ? (
            <p className="py-6 text-center font-mono text-[0.7rem] uppercase tracking-stamp text-faint">
              Loading…
            </p>
          ) : sessions.length === 0 ? (
            <p className="py-6 text-center font-mono text-[0.7rem] uppercase tracking-stamp text-faint">
              No sessions.
            </p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-[2px] border border-line px-3.5 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[0.92rem] font-semibold text-ink">
                      {s.device_name || deviceLabel(s.user_agent)}
                    </span>
                    {s.is_owner && (
                      <span className="shrink-0 rounded-[2px] border border-line-strong px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-stamp text-silver">
                        Owner
                      </span>
                    )}
                    {s.is_current && (
                      <span className="shrink-0 rounded-[2px] bg-ink px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-stamp text-bg">
                        You
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[0.64rem] text-muted">
                    {s.client_ip} · joined {fmt(s.created_at)}
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(s)}
                  disabled={busyId === s.id}
                  className="shrink-0 rounded-[2px] border border-danger/50 px-3 py-1.5 font-mono text-[0.66rem] uppercase tracking-stamp text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                >
                  {busyId === s.id ? "…" : s.is_current ? "Sign out" : "Remove"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
