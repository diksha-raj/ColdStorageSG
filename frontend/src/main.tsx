import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from "react-router";
import { AuthProvider, useAuth } from "./auth";
import { AppLayout } from "./components/Layout";
import { Loading } from "./components/ui";
import "./index.css";
import { ParticipantsProvider } from "./lib/participants";
import { CertificatePrint } from "./pages/CertificatePrint";
import { ClaimPage } from "./pages/ClaimPage";
import { Dashboard } from "./pages/Dashboard";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { ShipmentPage } from "./pages/ShipmentPage";
import { VerifyPage } from "./pages/VerifyPage";

/** Signed-in users with an approved role only; everyone else goes to the login page. */
function RequireRole() {
  const { session, loading } = useAuth();
  if (loading) return <Loading />;
  if (!session?.role) return <Navigate to="/login" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  { path: "/", element: <Landing /> },
  { path: "/login", element: <Login /> },
  // Public: opened from the QR code on a printed certificate, no sign-in needed.
  { path: "/verify/:batchId", element: <VerifyPage /> },
  {
    element: <RequireRole />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: "/app", element: <Dashboard /> },
          { path: "/shipments/:id", element: <ShipmentPage /> },
          { path: "/claims/:id", element: <ClaimPage /> },
        ],
      },
      {
        // Printable certificate: no app header, so it prints as a clean document.
        path: "/certificates/:batchId/print",
        element: (
          <ParticipantsProvider>
            <CertificatePrint />
          </ParticipantsProvider>
        ),
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
