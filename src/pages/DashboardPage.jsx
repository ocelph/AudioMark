import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, useNavigate } from "react-router-dom";
import { collection, query, orderBy, onSnapshot, updateDoc, deleteDoc, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { deleteObject, ref } from "firebase/storage";
import { FileText, LogOut, Plus, UserCircle } from "lucide-react";
import { auth, db, storage } from "../services/firebase";
import AddProjectModal from "../components/AddProjectModal";
import ProjectActionsMenu from "../components/ProjectActionsMenu";
import EditProjectModal from "../components/EditProjectModal";
import DeleteProjectModal from "../components/DeleteProjectModal";
import ShareProjectModal from "../components/ShareProjectModal";
import Logo from '../components/Logo';
import backgroundImg from "../assets/login_page_background.png";

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "00:00";

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const timestampToMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();

  const millis = new Date(value).getTime();
  return Number.isNaN(millis) ? 0 : millis;
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("User");
  const [currentUserId, setCurrentUserId] = useState(null);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sharedProjectsError, setSharedProjectsError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  
  //Project action modals
  const [selectedProject, setSelectedProject] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [projectFilter, setProjectFilter] = useState("all");

  useEffect(() => {
    document.title = "AudioMark - Dashboard";

    let unsubscribeOwned = () => {};
    let unsubscribeShared = () => {};

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUserId(user?.uid || null);
      if (user?.displayName) {
        setUsername(user.displayName.split(" ")[0]);
      } else if (user?.email) {
        setUsername(user.email.split("@")[0]);
      } else {
        setUsername("User");
      }

      if (!user) {
        unsubscribeOwned();
        unsubscribeShared();
        setProjects([]);
        setSharedProjectsError("");
        setLoading(false);
        return;
      }

      const accountFirstName =
        user.displayName?.split(" ")[0] || user.email?.split("@")[0] || "owner";
      setSharedProjectsError("");

      const projectLists = { owned: [], shared: [] };
      const updateProjects = () => {
        const merged = new Map();
        [...projectLists.owned, ...projectLists.shared].forEach((project) => {
          merged.set(`${project.ownerId}:${project.id}`, project);
        });
        setProjects([...merged.values()]);
        setLoading(false);
      };

      const ownedQuery = query(
        collection(db, "users", user.uid, "projects"),
        orderBy("created_at", "desc")
      );
      const sharedQuery = query(
        collection(db, "shared_projects", (user.email || "").toLowerCase(), "projects")
      );

      unsubscribeOwned = onSnapshot(
        ownedQuery,
        (snapshot) => {
          projectLists.owned = snapshot.docs.map((projectDoc) => ({
            id: projectDoc.id,
            ownerId: user.uid,
            isOwned: true,
            owner_name: accountFirstName,
            ...projectDoc.data(),
          }));
          snapshot.docs.forEach((projectDoc) => {
            const project = projectDoc.data();
            (project.shared_with || []).forEach((recipient) => {
              const permission = (project.shared_permissions || []).find(
                (item) => item.email === recipient
              );
              setDoc(
                doc(db, "shared_projects", recipient, "projects", `${user.uid}_${projectDoc.id}`),
                {
                  ...project,
                  ownerId: user.uid,
                  projectId: projectDoc.id,
                  projectTitle: project.project_title || "",
                  owner_name: accountFirstName,
                  role: permission?.role || "viewer",
                },
                { merge: true }
              ).catch((error) => console.error("Error indexing shared project:", error));
            });
          });
          updateProjects();
        },
        (error) => {
          console.error("Error fetching owned projects:", error);
          setLoading(false);
        }
      );

      unsubscribeShared = onSnapshot(
        sharedQuery,
        async (snapshot) => {
          setSharedProjectsError("");
          projectLists.shared = await Promise.all(snapshot.docs.map(async (accessDoc) => {
            const access = accessDoc.data();
            const ownerId = access.ownerId;
            let project = access;

            if (!project.project_title) {
              const projectSnapshot = await getDoc(
                doc(db, "users", ownerId, "projects", access.projectId)
              );
              if (projectSnapshot.exists()) {
                project = { ...project, ...projectSnapshot.data() };
              }
            }

            let ownerName = project.owner_name;
            if (!ownerName) {
              ownerName = "owner";
            }

            return {
              id: access.projectId,
              ownerId,
              isOwned: ownerId === user.uid,
              owner_name: ownerName,
              ...project,
            };
          }));
          projectLists.shared = projectLists.shared.filter(Boolean);
          updateProjects();
        },
        (error) => {
          console.error("Error fetching shared projects:", error);
          setSharedProjectsError(
            `Could not load shared projects (${error.code || "unknown"}): ${error.message} ` +
            `App project: ${db.app.options.projectId}; account: ${user.email || "no email claim"}.`
          );
          setLoading(false);
        }
      );
    });

    return () => {
      unsubscribe();
      unsubscribeOwned();
      unsubscribeShared();
    };
  }, []);

  const visibleDocuments = useMemo(() => {
    return projects
      .filter((project) => {
        if (projectFilter === "owned") return project.isOwned;
        if (projectFilter === "shared") return !project.isOwned;
        return true;
      })
      .sort((first, second) => {
      const firstDate = timestampToMillis(
        first.last_accessed_by?.[currentUserId] || first.last_accessed_at || first.created_at
      );
      const secondDate = timestampToMillis(
        second.last_accessed_by?.[currentUserId] || second.last_accessed_at || second.created_at
      );

        return secondDate - firstDate;
      });
  }, [projects, projectFilter, currentUserId]);

  const handleEdit = async (formData) => {
    if (!selectedProject) return;
    setActionLoading(true);

    try {
      const projectsRef = collection(db, "users", auth.currentUser.uid, "projects");
      const existingProjects = await getDocs(projectsRef);
      const normalizedTitle = formData.project_title.trim().toLowerCase();
      const titleExists = existingProjects.docs.some(
        (projectDoc) =>
          projectDoc.id !== selectedProject.id &&
          (projectDoc.data().project_title || "").trim().toLowerCase() === normalizedTitle
      );

      if (titleExists) return "A project with this title already exists";

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
      return null;
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
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Project filter">
              {[
                ["all", "All projects"],
                ["owned", "Owned by me"],
                ["shared", "Shared to me"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setProjectFilter(value)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${projectFilter === value
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {sharedProjectsError && (
              <p role="alert" className="text-sm text-red-600">
                {sharedProjectsError}
              </p>
            )}

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
                  to={`/project/${document.id}/annotation?ownerId=${document.ownerId}`}
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
                        {document.isOwned ? (
                          <>Owner: <span className="font-medium">{username}</span></>
                        ) : (
                          <>Owner: <span className="font-medium">{document.owner_name || "owner"}</span></>
                        )}
                      </div>
                    </div>

                    <div className="flex min-w-[220px] flex-col items-start gap-2 text-left text-base text-slate-600 lg:items-end lg:text-right">
                      {(document.last_accessed_by?.[currentUserId] || document.last_accessed_at) && (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Last accessed</span>
                          <span>
                            {new Date(
                              document.last_accessed_by?.[currentUserId]?.toDate?.() ||
                              document.last_accessed_by?.[currentUserId] ||
                              document.last_accessed_at?.toDate?.() ||
                              document.last_accessed_at
                            ).toLocaleDateString()}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <span className="font-medium">Created on</span>
                        <span>
                          {document.created_at
                            ? new Date(document.created_at.toDate?.() || document.created_at).toLocaleDateString()
                            : "N/A"}
                        </span>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        {document.isOwned && (
                          <div onClick={(e) => e.preventDefault()}>
                            <ProjectActionsMenu
                              projectId={document.id}
                              projectTitle={document.project_title}
                              onEdit={() => {
                                openProjectActions(document);
                                setShowEditModal(true);
                              }}
                              onShare={() => {
                                openProjectActions(document);
                                setShowShareModal(true);
                              }}
                              onDelete={() => {
                                openProjectActions(document);
                                setShowDeleteModal(true);
                              }}
                            />
                          </div>
                        )}
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

        <ShareProjectModal
          isOpen={showShareModal}
          onClose={() => {
            setShowShareModal(false);
            setSelectedProject(null);
          }}
          projectId={selectedProject?.id}
          ownerId={auth.currentUser?.uid}
          projectTitle={selectedProject?.project_title || ""}
          ownerName={selectedProject?.owner_name || username}
          sharedWith={selectedProject?.shared_with || []}
          sharedPermissions={selectedProject?.shared_permissions || []}
          onSharedWithChange={(sharedWith, sharedPermissions) =>
            setSelectedProject((project) => (project ? {
              ...project,
              shared_with: sharedWith,
              shared_permissions: sharedPermissions,
            } : project))
          }
        />
      </div>
    </div>
  );
}
