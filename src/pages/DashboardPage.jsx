import { useState, useEffect } from "react";

export default function DashboardPage() {
  useEffect(() => {
    document.title = "AudioMark — Dashboard";
  }, []);


  return <h1>Hello world</h1>;
}
