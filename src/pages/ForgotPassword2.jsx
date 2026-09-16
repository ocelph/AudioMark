import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import backgroundImage from "../assets/login_page_background.png";
import Logo from '../components/Logo';

export default function ForgotPassword2() {
  useEffect(() => {
    document.title = "AudioMark — Forgot Password Success";
  }, []);


  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden px-4 py-10"
        style={{ backgroundImage: `url(${backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" }}>
                
    <div className="relative z-10 w-full max-w-md bg-white rounded-3xl shadow-xl p-8 sm:p-10">
        
    <div className="mb-6">
        <Logo/>
    </div>

    <h1 className="text-2xl font-bold text-slate-900 text-center">Email Sent</h1>
    <p className="text-sm text-slate-500 text-center mt-2 mb-8">
        If an account is associated with the information entered, you will receive an email shortly
    </p>

    <div className="flex justify-center">
        <Link to="/Login" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
            Return to Login
        </Link>
    </div>
        
    </div>   

    </div>
  )
}
