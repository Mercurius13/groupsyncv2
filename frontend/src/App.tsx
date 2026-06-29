import { BrowserRouter, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./AuthContext";
import { Layout } from "./components/Layout";
import { AssignmentPage } from "./pages/AssignmentPage";
import { AuthCallback } from "./pages/AuthCallback";
import { ClassPage } from "./pages/ClassPage";
import { Dashboard } from "./pages/Dashboard";
import { GroupPage } from "./pages/GroupPage";
import { Login } from "./pages/Login";

function Protected({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <Layout>{children}</Layout>
    </RequireAuth>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/" element={<Protected><Dashboard /></Protected>} />
        <Route path="/classes/:classId" element={<Protected><ClassPage /></Protected>} />
        <Route
          path="/classes/:classId/assignments/:assignmentId"
          element={<Protected><AssignmentPage /></Protected>}
        />
        <Route
          path="/classes/:classId/assignments/:assignmentId/groups/:groupId"
          element={<Protected><GroupPage /></Protected>}
        />
      </Routes>
    </BrowserRouter>
  );
}
