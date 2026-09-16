import { useState, useEffect } from "react";
import { AudioWaveform, User, Mail, Lock, Eye, EyeOff } from "lucide-react"; // icon components
import backgroundImage from "../assets/login_page_background.png";
import { Link } from "react-router-dom";
import Logo from '../components/Logo';
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../services/firebase";
import { getFunctions, httpsCallable } from "firebase/functions";

export default function RegisterPage() {
  // useState — "hook" that lets a function component hold data that can change over time and trigger a re-render when it does.
  // form: one object holding all 5 field values; setForm is the only way to update it.
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [errors, setErrors] = useState({}); // holds validation error messages, keyed by field name (example: errors.password)
  const [registerRequest, sentRequest] = useState(false); // keep track of successful registration  
  const [submitting, setSubmitting] = useState(false);

  
  useEffect(() => {
    document.title = "AudioMark — Create Account";
  }, []);


  // runs on every keystroke in any input form, copies the existing form object and overwrites just the target field
  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();   // e.preventDefault() stops the browser's default behavior of reloading the page on submit
    
    const newErrors = {};
    if (form.password.length < 8) {
      newErrors.password = "Password must be at least 8 characters.";
    }
    
    if (form.password !== form.confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match.";
    }

    if (form.firstName === "") {
      newErrors.firstName = "Required field.";
    }

    if (form.lastName === "") {
      newErrors.lastName = "Required field.";
    }

    // (?=.{4,}@)             - checks there are at least 4 characters between start and @
    // [a-zA-Z0-9]+           — must start with a letter/digit, not a dot.
    // (?:\.[a-zA-Z0-9]+)*    - zero or more "dot + alphanumeric block" segments
    // @[a-zA-Z0-9]+          — after @, must be a letter or digit 
    // (?:[-.][a-zA-Z0-9]+)*  — zero or more "dot/hyphen followed by alphanumeric block" segments
    // \.[a-zA-Z0-9]+$        — finally one more dot + alphanumeric block at the end
    const emailRegex = /^(?=.{4,}@)[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*@[a-zA-Z0-9]+(?:[-.][a-zA-Z0-9]+)*\.[a-zA-Z0-9]+$/;
    if (form.email === "") {
      newErrors.email = "Required field.";
    } else if (!emailRegex.test(form.email)) {
      newErrors.email = "Enter a valid email address.";
    }
  
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSubmitting(true);
    setErrors({});

    try {
      console.log("1. Starting registration");
      const registrationStart = performance.now();

      const functions = getFunctions();
      const registerUser = httpsCallable(functions, "registerUser");

      const result = await registerUser({
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        password: form.password,
      })
      // // Creates the Auth account. Throws auth/email-already-in-use automatically if that email is already registered.
      // const userCredential = await createUserWithEmailAndPassword(
      //   auth,
      //   form.email,
      //   form.password
      // );

      const uid = result.data.uid;

      // // Use the Auth UID as the Firestore document ID, so each user's document has same unique ID.
      // await setDoc(doc(db, "users", uid), {
      //   firstName: form.firstName,
      //   lastName: form.lastName,
      //   email: form.email,
      //   createdAt: new Date().toISOString(),
      // });

      console.log("2. Firestore user document created");
      console.log(
        "Firestore write took:",
        ((performance.now() - firestoreStart) / 1000).toFixed(2),
        "seconds"
      );

      sentRequest(true);
      console.log("Request sent for new user:", uid);
      sentRequest(true);

    } catch (err) {
          console.error("Registration error:", err);

      if (err.code === "auth/email-already-in-use") {
        setErrors({ email: "Email already in use." });
      } else if (err.code === "auth/invalid-email") {
        setErrors({ email: "Enter a valid email address." });
      } else if (err.code === "auth/weak-password") {
        setErrors({ password: "Password is too weak." });
      } else if (err.code === "auth/too-many-requests") {
        setErrors({ general: "Unusual sign-up activity detected. Please try again later" })
      } else {
        setErrors({ general: "Something went wrong. Please try again."});
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // outer div, page wrapper: flex items-center justify-center: centers the card both vertically and horizontally

    // next div, white form card: max-w-md caps its width so it doesn't stretch too wide on large screens, z-10 keeps it above the background


    // className="grid grid-cols-1 sm":grid-cols-2 gap-4: A grid that's a single column on small screens (`grid-cols-1`) and switches to two side-by-side columns from the `sm(640px)` breakpoint up (`sm:grid-cols-2`)
    // className="text-slate-700" means use shade 700 from the slate palette as the text color
    // className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm p": Width- 100% of the parent container; padding-left, right, top and bottom ; Border-radius;
    // className="relative": The wrapper is relative so the icon can be absolute-positioned inside it, vertically centered

    // type={showPassword ? "text" : "password"}: The type attribute flips between "password" (dots) and "text" (visible) based on state.
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden px-4 py-10"
          style={{ backgroundImage: `url(${backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" }}>
      
      <div className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-xl p-8 sm:p-10">
        
        <div className="mb-6">
          <Logo />
        </div>

        <h1 className="text-2xl font-bold text-slate-900 text-center">Create your account</h1>
        <p className="text-sm text-slate-500 text-center mt-2 mb-8">
          Join AudioMark to start annotating and extracting audio effortlessly.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"> 
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">First name</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  name="firstName"
                  value={form.firstName}
                  onChange={handleChange}
                  placeholder="First name"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              {errors.firstName && (
                <p className="text-xs text-red-500 mt-1">{errors.firstName}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Last name</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  name="lastName"
                  value={form.lastName}
                  onChange={handleChange}
                  placeholder="Last name"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              {errors.lastName && (
                <p className="text-xs text-red-500 mt-1">{errors.lastName}</p>
              )}
            </div>
          </div>

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
            {errors.email && (
              <p className="text-xs text-red-500 mt-1">{errors.email}</p>
            )}
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
                placeholder="Create a password"
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
            <p className={`text-xs mt-1 ${errors.password ? "text-red-500" : "text-slate-400"}`}>
              {errors.password || "Must be at least 8 characters long."}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type={showConfirm ? "text" : "password"}
                name="confirmPassword"
                value={form.confirmPassword}
                onChange={handleChange}
                placeholder="Confirm your password"
                className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-200 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label={showConfirm ? "Hide password" : "Show password"}
              >
                {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.confirmPassword && (
              <p className="text-xs text-red-500 mt-1">{errors.confirmPassword}</p>
            )}
          </div>

          {errors.general && (
            <p className="text-sm text-red-500 text-center">{errors.general}</p>
          )}
          <button
            type="submit"
            disabled={submitting || registerRequest}
            className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold py-3 rounded-xl mt-2 hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {/* if registered true: changes to Account registered and grey out button*/}
            {/* else if submitting true: changes to Creating account and grey out button*/}
            {/* else default Create account button*/}
            {registerRequest ? "Request sent" 
                        : submitting ? "Sending request..."  
                                     : "Create account"} 
          </button>
        </form>

        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 border-t border-slate-200" />
          <span className="text-xs text-slate-400 whitespace-nowrap">Already have an account?</span>
          <div className="flex-1 border-t border-slate-200" />
        </div>

        <Link to="/login" className="w-full border border-indigo-600 text-indigo-600 font-semibold py-3 rounded-xl hover:bg-indigo-50 transition block text-center">
          Log in
        </Link>

        <p className="text-xs text-slate-400 text-center mt-8">
          © 2026 AudioMark. All rights reserved.
        </p>
      </div>
    </div>
  );
}