import { PlayerShell } from "../../components/navigation-shell";
import { SessionGate } from "../../components/session-gate";
import { OnboardingGuideProvider } from "../../providers/onboarding-guide-context";

export default function PlayerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SessionGate allowedRoles={["player", "admin"]}><OnboardingGuideProvider><PlayerShell>{children}</PlayerShell></OnboardingGuideProvider></SessionGate>;
}
