import { useState, useEffect } from "react";
import { AudioWaveform, Mail, Lock, Eye, EyeOff } from "lucide-react";
import backgroundImage from "../assets/login_page_background.png";
import { Link, useNavigate } from "react-router-dom";
import Logo from '../components/Logo';
import { auth } from "../services/firebase";
import {signInWithEmailAndPassword} from "firebase/auth";

export default function LoginPage() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    email: "",
    password: "",
  });
  
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);  


  useEffect(() => {
    document.title = "AudioMark — Log In";
  }, []);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const newErrors = {};

    if (!form.email.trim()) {
      newErrors.email = "Email is required.";
    }

    if (!form.password) {
      newErrors.password = "Password is required.";
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSubmitting(true);
    setErrors({});

    try {
      console.log("1. Starting login");
      const start = performance.now();

      const userCredential = await signInWithEmailAndPassword(
        auth,
        form.email.trim().toLowerCase(),
        form.password
      );

      console.log("2. Firebase login finished");
      console.log(
        "Login took:",
        ((performance.now() - start) / 1000).toFixed(2),
        "seconds"
      );
      console.log("Logged in user:", userCredential.user.uid);

      console.log("3. Navigating to dashboard");

      navigate("/dashboard");

    } catch (err) {
      console.error("LOGIN ERROR:", err);
      console.error("Code:", err.code);
      console.error("Message:", err.message);

      const networkOrServerIssue = [
        "auth/network-request-failed",
        "auth/internal-error",
        "auth/too-many-requests",
        "auth/operation-not-allowed",
      ].includes(err.code);

      if (networkOrServerIssue) {
        setErrors({
          general: "Something went wrong. Please try again later."
        });
      } else {
        setErrors({
          password: "Invalid credentials"
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
   <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden px-4 py-10"
        style={{ backgroundImage: `url(${backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" }}>
         
      <div className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-xl p-8 sm:p-10">
        <div className="mb-6">
          <Logo />
        </div>

        <h1 className="text-2xl font-bold text-slate-900 text-center">Welcome back</h1>
        <p className="text-sm text-slate-500 text-center mt-2 mb-8">
          Log in to continue annotating and extracting audio with ease.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                placeholder="Enter your email"
                className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                value={form.password}
                onChange={handleChange}
                placeholder="Enter your password"
                className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-200 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.password && <p className="text-xs text-red-500 mt-1">{errors.password}</p>}
          </div>

          {errors.general && (
            <p className="text-sm text-red-500 text-center">{errors.general}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold py-3 rounded-xl mt-2 hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? "Logging in..." : "Log in"}
          </button>

          <div className="flex items-center justify-between">
            <a href="#" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
              Forgot password?
            </a>
          </div>

        </form>

        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 border-t border-slate-200" />
          <span className="text-xs text-slate-400 whitespace-nowrap">Don't have an account?</span>
          <div className="flex-1 border-t border-slate-200" />
        </div>

        <Link to="/register" className="w-full border border-indigo-600 text-indigo-600 font-semibold py-3 rounded-xl hover:bg-indigo-50 transition block text-center">
          Register
        </Link>

        <p className="text-xs text-slate-400 text-center mt-8">
          © 2026 AudioMark. All rights reserved.
        </p>
      </div>
    </div>
  );
}
