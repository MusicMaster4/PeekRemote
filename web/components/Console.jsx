"use client";

import { useState } from "react";
import { logout } from "@/lib/api";
import LiveUse from "@/components/LiveUse";
import Sessions from "@/components/Sessions";

export default function Console({ onLogout, isOwner = false, os = "windows" }) {
  const [sessionsOpen, setSessionsOpen] = useState(false);

  async function handleLogout() {
    await logout();
    onLogout();
  }

  return (
    <>
      <LiveUse
        isOwner={isOwner}
        os={os}
        onLogout={onLogout}
        onSignOut={handleLogout}
        onSessions={() => setSessionsOpen(true)}
      />

      {sessionsOpen && (
        <Sessions onClose={() => setSessionsOpen(false)} onLogout={onLogout} />
      )}
    </>
  );
}
