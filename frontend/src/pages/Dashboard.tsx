import { useAuth } from "../auth";
import { AdminDashboard } from "./dashboards/AdminDashboard";
import { BuyerDashboard } from "./dashboards/BuyerDashboard";
import { CustodianDashboard } from "./dashboards/CustodianDashboard";
import { ImporterDashboard } from "./dashboards/ImporterDashboard";
import { InspectorDashboard } from "./dashboards/InspectorDashboard";

export function Dashboard() {
  const { session } = useAuth();
  switch (session?.role) {
    case "ADMIN":
      return <AdminDashboard />;
    case "IMPORTER":
      return <ImporterDashboard />;
    case "CARRIER":
    case "HANDLER":
    case "COLD_STORE":
    case "TRUCK":
      return <CustodianDashboard role={session.role} />;
    case "BUYER":
      return <BuyerDashboard />;
    case "INSPECTOR":
      return <InspectorDashboard />;
    default:
      return null;
  }
}
