import { AdminShell } from "../../components/navigation-shell";
import { SessionGate } from "../../components/session-gate";

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SessionGate allowedRoles={["admin"]}><AdminShell>{children}</AdminShell></SessionGate>;
}
