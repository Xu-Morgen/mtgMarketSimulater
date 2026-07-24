import { PlayerShell } from "../../components/navigation-shell";
import { SessionGate } from "../../components/session-gate";

export default function PlayerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SessionGate allowedRoles={["player", "admin"]}><PlayerShell>{children}</PlayerShell></SessionGate>;
}
