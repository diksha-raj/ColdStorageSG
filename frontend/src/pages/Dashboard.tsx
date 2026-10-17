import { useAuth } from "../auth";
import { AdminDashboard } from "./dashboards/AdminDashboard";
import { BuyerDashboard } from "./dashboards/BuyerDashboard";
import { CustodianDashboard } from "./dashboards/CustodianDashboard";
import { SupplierDashboard } from "./dashboards/SupplierDashboard";
import { InspectorDashboard } from "./dashboards/InspectorDashboard";

export function Dashboard() {
  const { session } = useAuth();
  switch (session?.role) {
    case "ADMIN":
      return <AdminDashboard />;
    case "SUPPLIER":
      return <SupplierDashboard />;
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
