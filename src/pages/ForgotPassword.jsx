import { useState, useEffect } from "react";
import backgroundImage from "../assets/login_page_background.png";
import { Link, useNavigate } from "react-router-dom";
import Logo from '../components/Logo';
import { AudioWaveform, User, Mail, Lock, Eye, EyeOff, ArrowLeft } from "lucide-react";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../services/firebase";

export default function ForgotPassword() {
    const [form, setForm] = useState({
        email : ""
    })

    const navigate = useNavigate();
    const [errors, setErrors] = useState({});
    const [submitting, setSubmitting] = useState(false);  

    useEffect(() => {
        document.title = "AudioMark — Forgot Password";
    }, []);

    const handleChange = (e) => {
        setForm({ ...form, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e) => {
        e.preventDefault(); 
        const newErrors = {};

        if (!form.email) {
            newErrors.email = "Email is required.";
        }

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setSubmitting(true);
        setErrors({});

        try {
            await sendPasswordResetEmail(auth, form.email);
            navigate("/forgotpassword2");
        } catch (err) {
            console.log("ERROR CODE:", err.code);
            console.log("ERROR MESSAGE:", err.message);
            setErrors({ email: "Please enter a valid email address"});
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden px-4 py-10"
                style={{ backgroundImage: `url(${backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" }}>
            
        <div className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-xl p-8 sm:p-10">

        <Link to="/Login">
          <ArrowLeft/>  
        </Link>
                
        <div className="mb-6">
          <Logo/>
        </div>

        <h1 className="text-2xl font-bold text-slate-900 text-center">Forgot Password?</h1>
        <p className="text-sm text-slate-500 text-center mt-2 mb-8">
          Enter your email to restore your account
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
        <div>
        <input 
            type="email" 
            name="email" 
            value={form.email}
            onChange={handleChange}
            placeholder="Enter your Email"
            className="w-full pl-3 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />

        {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
        
        <button 
            type="submit"
            className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold py-3 rounded-xl mt-2 hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
            Next
        </button>

        
        </div>

        </form>

        </div>
        </div>
    )

};