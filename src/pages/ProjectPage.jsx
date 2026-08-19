import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../services/firebase";

export default function ProjectPage() {
    const { projectId } = useParams();
    const navigate = useNavigate();
    const [project, setProject] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [audioError, setAudioError] = useState(null);

    const audioRef = useRef(null);

    // Fetch project metadata from Firestore
    useEffect(() => {
        const fetchProject = async () => {
            try {
                const user = auth.currentUser;
                if (!user) {
                    navigate("/login");
                    return;
                }

                const projectRef = doc(db, "users", user.uid, "projects", projectId);
                const projectSnap = await getDoc(projectRef);

                if (projectSnap.exists()) {
                    setProject({ id: projectSnap.id, ...projectSnap.data() });
                    document.title = `${projectSnap.data().project_title} - AudioMark`;
                } else {
                    setError("Project not found");
                }
            } catch (err) {
                console.error("Error fetching project:", err);
                setError("Failed to load project");
            } finally {
                setLoading(false);
            }
        };

        fetchProject();
    }, [projectId, navigate]);

    const handlePlay = () => {
        audioRef.current?.play();
    };

    const handlePause = () => {
        audioRef.current?.pause();
    };

    if (loading) {
        return <div>Loading project...</div>;
    }

    if (error || !project) {
        return (
            <div>
                <p className="text-red-600 mb-4">{error || "Project not found"}</p>
                <Link to="/dashboard">Back to Dashboard</Link>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center">
            <h1 className="text-3xl font-bold text-slate-900 break-words">
                {project.project_title}
            </h1>

            {project.download_url ? (
                <>
                    <audio
                        ref={audioRef}
                        src={project.download_url}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onEnded={() => setIsPlaying(false)}
                        onError={() => setAudioError("Could not load the audio file")}
                        preload="metadata"
                    />

                    <div className="flex gap-3">
                        <button
                            type="button"
                            onClick={handlePlay}
                            disabled={isPlaying}
                            className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Play
                        </button>
                        <button
                            type="button"
                            onClick={handlePause}
                            disabled={!isPlaying}
                            className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Pause
                        </button>
                        
                    </div>
                    <Link to="/dashboard">Back to Dashboard</Link>

                    {audioError && <p className="text-sm text-red-600">{audioError}</p>}
                </>
            ) : (
                <p className="text-sm text-slate-600">No audio file attached.</p>
            )}
        </div>
    );
}