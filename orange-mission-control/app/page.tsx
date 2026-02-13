import AuthGate from "./components/AuthGate";
import DashboardClient from "./components/DashboardClient";

export default function Home() {
  return (
    <AuthGate>
      <DashboardClient />
    </AuthGate>
  );
}
