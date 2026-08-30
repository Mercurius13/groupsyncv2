import { BrowserRouter, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./AuthContext";
import { Layout } from "./components/Layout";
import { Account } from "./pages/Account";
import { AuthCallback } from "./pages/AuthCallback";
import { Login } from "./pages/Login";

// Pivoted 2026-07-03: the frontend is onboarding + account/plan only.
// Class/assignment/group pages and the evidence viewer were removed —
// Canvas organizes classes, and analysis renders in the extension popup.

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout>
                <Account />
              </Layout>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
