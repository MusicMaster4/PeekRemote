"use client";

import { useEffect, useState } from "react";
import { getSession } from "@/lib/api";
import Login from "@/components/Login";
import Console from "@/components/Console";

function Splash() {
  return (
    <div className="grid min-h-[100svh] place-items-center px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="font-display text-4xl uppercase tracking-tight text-ink">
          Peek Remote
        </h1>
        <span className="h-5 w-5 animate-spin rounded-full border border-line border-t-ink" />
      </div>
    </div>
  );
}

export default function Page() {
  // null = checking session; object = result.
  const [session, setSession] = useState(null);

  const refresh = () =>
    getSession().then((s) => setSession(s ?? { authenticated: false, isOwner: false }));

  useEffect(() => {
    let active = true;
    getSession().then((s) => active && setSession(s));
    return () => {
      active = false;
    };
  }, []);

  if (session === null) return <Splash />;
  if (!session.authenticated)
    return <Login onSuccess={() => refresh()} />;
  return (
    <Console
      isOwner={session.isOwner}
      onLogout={() => setSession({ authenticated: false, isOwner: false })}
    />
  );
}
