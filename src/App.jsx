import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import RegisterPage from './pages/RegisterPage'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import ProjectPage from './pages/ProjectPage'
import AnnotationPage from './pages/AnnotationPage'
import ForgotPassword from './pages/ForgotPassword'
import ForgotPassword2 from './pages/ForgotPassword2'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />

        <Route path="/project/:ownerId/:projectId" element={<ProjectPage />} />
        <Route
          path="/project/:ownerId/:projectId/annotation"
          element={<AnnotationPage />}
        />

        <Route path="/forgotpassword" element={<ForgotPassword />} />
        <Route path="/forgotpassword2" element={<ForgotPassword2 />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App