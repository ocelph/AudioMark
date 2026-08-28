import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, useNavigate } from "react-router-dom";
import { collection, query, orderBy, onSnapshot, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { deleteObject, ref } from "firebase/storage";
import { FileText, LogOut, Plus, UserCircle } from "lucide-react";
import { auth, db, storage } from "../services/firebase";
import AddProjectModal from "../components/AddProjectModal";
import ProjectActionsMenu from "../components/ProjectActionsMenu";
import EditProjectModal from "../components/EditProjectModal";
import DeleteProjectModal from "../components/DeleteProjectModal";
import Logo from '../components/Logo';
import backgroundImg from "../assets/login_page_background.png";

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "00:00";

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("User");
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  
  //Project action modals
  const [selectedProject, setSelectedProject] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    document.title = "AudioMark - Dashboard";

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user?.displayName) {
        setUsername(user.displayName.split(" ")[0]);
      } else if (user?.email) {
        setUsername(user.email.split("@")[0]);
      } else {
        setUsername("User");
      }

      //Fetch user's projects
      if (user) {
        const projectsRef = collection(db, "users", user.uid, "projects");
        const q = query(projectsRef, orderBy("created_at", "desc"));

        const unsubscribeProjects = onSnapshot(
          q,
          (snapshot) => {
            const projectsList = snapshot.docs.map((doc) => ({
              id: doc.id,
              ...doc.data(),
            }));
            setProjects(projectsList);
            setLoading(false);
          },
          (error) => {
            console.error("Error fetching projects:", error);
            setLoading(false);
          }
        );

        return () => unsubscribeProjects();
      } else {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const visibleDocuments = useMemo(() => {
    return projects;
  }, [projects]);

  const handleEdit = async (formData) => {
    if (!selectedProject) return;
    setActionLoading(true);

    try {
      const projectRef = doc(
        db,
        "users",
        auth.currentUser.uid,
        "projects",
        selectedProject.id
      );
      await updateDoc(projectRef, {
        project_title: formData.project_title,
        description: formData.description || null,
        updated_at: new Date().toISOString(),
      });
      setShowEditModal(false);
      setSelectedProject(null);
    } catch (error) {
      console.error("Error updating project:", error);
      alert("Failed to update project");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProject) return;
    setActionLoading(true);

    try {
      const projectRef = doc(
        db,
        "users",
        auth.currentUser.uid,
        "projects",
        selectedProject.id
      );

      if (selectedProject.storage_path) {
        try {
          await deleteObject(ref(storage, selectedProject.storage_path));
        } catch (error) {
          if (error.code !== "storage/object-not-found") {
            throw error;
          }
        }
      }

      await deleteDoc(projectRef);
      setShowDeleteModal(false);
      setSelectedProject(null);
    } catch (error) {
      console.error("Error deleting project:", error);
      alert("Failed to delete project");
    } finally {
      setActionLoading(false);
    }
  };

  const openProjectActions = (project) => {
    setSelectedProject(project);
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      navigate("/login");
    } catch (error) {
      console.error("Error logging out:", error);
      alert("Failed to log out");
    }
  };

  return (
    <div
      className="min-h-screen w-full px-4 py-8 sm:px-6 lg:px-10"
      style={{
        backgroundImage: `url(${backgroundImg})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="mx-auto max-w-[1280px]">
        <header className="relative z-50 mb-6 flex flex-col gap-4 overflow-visible rounded-[28px] border border-slate-200/80 bg-white/75 p-4 shadow-[0_20px_60px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
              <Logo/>
          </div>

          <div className="relative self-end lg:self-auto">
            <button
              type="button"
              title={`Account: ${username}`}
              aria-label={`Account: ${username}`}
              aria-expanded={showAccountMenu}
              onClick={() => setShowAccountMenu((isOpen) => !isOpen)}
              className="rounded-full text-slate-600 transition hover:text-indigo-600"
            >
              <UserCircle className="h-9 w-9" strokeWidth={1.8} />
            </button>

            {showAccountMenu && (
              <div className="absolute right-0 top-full z-[60] mt-2 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="relative z-0 rounded-[30px] border border-slate-200/80 bg-white/70 p-4 shadow-[0_20px_60px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:p-6 lg:p-8">
          <div className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="mt-2 text-4xl font-black text-slate-900 sm:text-5xl">
                Welcome Back {username}
              </h2>
            </div>

            <button
              type="button"
              onClick={() => setShowModal(true)}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-200 transition hover:brightness-110"
            >
              <Plus className="h-4 w-4" />
              New Project
            </button>
          </div>

          <div className="space-y-5">
            {loading ? (
              <div className="text-center py-12">
                <p className="text-slate-600">Loading your projects...</p>
              </div>
            ) : visibleDocuments.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="h-12 w-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-600 mb-4">No projects yet</p>
                <button
                  type="button"
                  onClick={() => setShowModal(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2 font-medium hover:bg-indigo-700 transition"
                >
                  <Plus className="h-4 w-4" />
                  Create Your First Project
                </button>
              </div>
            ) : (
              visibleDocuments.map((document) => (
                <Link
                  key={document.id}
                  to={`/project/${document.id}/annotation`}
                  className="rounded-[26px] border border-slate-200 bg-white/90 p-4 shadow-[0_14px_30px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_35px_rgba(15,23,42,0.08)] sm:p-5 block"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-4">
                        <div>
                          <h3 className="mt-1 text-2xl font-black text-slate-900 sm:text-[2rem]">
                            {document.project_title}
                          </h3>
                        </div>
                      </div>

                      {document.metadata?.file_duration && (
                        <div className="mt-1 text-sm text-slate-600">
                          Duration: <span className="font-normal">{formatDuration(document.metadata.file_duration)}</span>
                        </div>
                      )}

                      <div className="mt-1 text-sm text-slate-600">
                        Owner: <span className="font-medium">{username}</span>
                      </div>
                    </div>

                    <div className="flex min-w-[220px] flex-col items-start gap-2 text-left text-base text-slate-600 lg:items-end lg:text-right">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Last accessed</span>
                        <span>
                          {document.last_accessed_at
                            ? new Date(
                                document.last_accessed_at.toDate?.() || document.last_accessed_at
                              ).toLocaleDateString()
                            : "Never"}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="font-medium">Created on</span>
                        <span>
                          {document.created_at
                            ? new Date(document.created_at.toDate?.() || document.created_at).toLocaleDateString()
                            : "N/A"}
                        </span>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <div onClick={(e) => e.preventDefault()}>
                          <ProjectActionsMenu
                            projectId={document.id}
                            projectTitle={document.project_title}
                            onEdit={() => {
                              openProjectActions(document);
                              setShowEditModal(true);
                            }}
                            onDelete={() => {
                              openProjectActions(document);
                              setShowDeleteModal(true);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </main>

        <AddProjectModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onProjectAdded={() => {
            // Projects will auto-refresh via the Firestore listener
          }}
        />

        <EditProjectModal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setSelectedProject(null);
          }}
          project={selectedProject}
          onSave={handleEdit}
          loading={actionLoading}
        />

        <DeleteProjectModal
          isOpen={showDeleteModal}
          onClose={() => {
            setShowDeleteModal(false);
            setSelectedProject(null);
          }}
          projectTitle={selectedProject?.project_title || ""}
          onDelete={handleDelete}
          loading={actionLoading}
        />
      </div>
    </div>
  );
}
