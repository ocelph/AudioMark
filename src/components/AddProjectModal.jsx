import { useState } from "react";
import { X, Plus, Upload, AlertCircle } from "lucide-react";
import { auth, db, storage } from "../services/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

const SUPPORTED_AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "webm", "m4a"];

const getFileExtension = (fileName) =>
  fileName.split(".").pop()?.toLowerCase() || "";

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const hasAudioSignature = (bytes) => {
  const text = (start, length) =>
    String.fromCharCode(...bytes.slice(start, start + length));

  const isMp3 =
    text(0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const isWav = text(0, 4) === "RIFF" && text(8, 4) === "WAVE";
  const isOgg = text(0, 4) === "OggS";
  const isFlac = text(0, 4) === "fLaC";
  const isM4a = text(4, 4) === "ftyp";
  const isWebm =
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3;

  return isMp3 || isWav || isOgg || isFlac || isM4a || isWebm;
};

export default function AddProjectModal({ isOpen, onClose, onProjectAdded }) {
  const [formData, setFormData] = useState({
    project_title: "",
    description: "",
    audioFile: null,
    audioDuration: null,
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filePreview, setFilePreview] = useState(null);

  const handleTitleChange = (e) => {
    setFormData((prev) => ({ ...prev, project_title: e.target.value }));
  };

  const handleDescriptionChange = (e) => {
    setFormData((prev) => ({ ...prev, description: e.target.value }));
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    setError(null);

    if (!file) {
      setFormData((prev) => ({
        ...prev,
        audioFile: null,
        audioDuration: null,
      }));
      setFilePreview(null);
      return;
    }

    const extension = getFileExtension(file.name);

    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(extension)) {
      setError(
        "Unsupported audio format. Please upload a WAV, MP3, FLAC, OGG, WebM, or M4A file."
      );
      e.target.value = "";
      return;
    }

    try {
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());

      if (!hasAudioSignature(header)) {
        setError("The file content does not match a supported audio format.");
        e.target.value = "";
        return;
      }

      const audio = new Audio();
      const objectUrl = URL.createObjectURL(file);

      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(objectUrl);

        setFormData((prev) => ({
          ...prev,
          audioFile: file,
          audioDuration: audio.duration,
        }));

        setFilePreview({
          name: file.name,
          size: (file.size / 1024).toFixed(2),
          type: file.type || "Unknown",
          format: extension.toUpperCase(),
          duration: formatDuration(audio.duration),
        });
      };

      audio.onerror = () => {
        URL.revokeObjectURL(objectUrl);

        setFormData((prev) => ({
          ...prev,
          audioFile: null,
          audioDuration: null,
        }));

        setFilePreview(null);
        setError(
          "The file looks like audio but could not be decoded by the browser."
        );
        e.target.value = "";
      };

      audio.src = objectUrl;
    } catch (err) {
      console.error("Error validating audio file:", err);

      setFormData((prev) => ({
        ...prev,
        audioFile: null,
        audioDuration: null,
      }));

      setFilePreview(null);
      setError(
        "Unable to validate the selected audio file. Please try another file."
      );
      e.target.value = "";
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const user = auth.currentUser;

      if (!user) {
        setError("You must be logged in to create a project");
        setLoading(false);
        return;
      }

      if (!formData.project_title.trim()) {
        setError("Project title is required");
        setLoading(false);
        return;
      }

      if (!formData.audioFile) {
        setError("Please select an audio file");
        setLoading(false);
        return;
      }

      const extension = getFileExtension(formData.audioFile.name);

      if (!SUPPORTED_AUDIO_EXTENSIONS.includes(extension)) {
        setError(
          "Unsupported audio format. Please upload a WAV, MP3, FLAC, OGG, WebM, or M4A file."
        );
        setLoading(false);
        return;
      }

      const fileName = `${user.uid}/${formData.project_title.replace(
        /\s+/g,
        "_"
      )}_${Date.now()}`;

      const storageRef = ref(storage, `audio_files/${fileName}`);
      const uploadResult = await uploadBytes(storageRef, formData.audioFile);
      const downloadUrl = await getDownloadURL(uploadResult.ref);
      const storagePath = uploadResult.ref.fullPath;

      const audioMeta = {
        file_size: formData.audioFile.size,
        file_format: extension,
        mime_type: formData.audioFile.type || null,
        file_duration: formData.audioDuration || null,
        original_file_name: formData.audioFile.name,
      };

      const projectsRef = collection(db, "users", user.uid, "projects");

      await addDoc(projectsRef, {
        project_title: formData.project_title.trim(),
        description: formData.description.trim() || null,
        storage_path: storagePath,
        download_url: downloadUrl,
        metadata: audioMeta,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });

      setFormData({
        project_title: "",
        description: "",
        audioFile: null,
        audioDuration: null,
      });

      setFilePreview(null);
      onProjectAdded?.();
      onClose();
    } catch (err) {
      console.error("Error creating project:", err);

      if (err?.code === "storage/unauthorized") {
        setError(
          "Upload was blocked by Firebase Storage rules. Please enable authenticated write access for the storage bucket."
        );
      } else if (err?.code === "storage/invalid-format") {
        setError("This file type is not supported by Firebase Storage.");
      } else {
        setError(err?.message || "Failed to create project");
      }
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-xl font-bold text-slate-900">
            Create New Project
          </h2>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-6 py-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Project Title <span className="text-red-500">*</span>
            </label>

            <input
              type="text"
              value={formData.project_title}
              onChange={handleTitleChange}
              placeholder="e.g., Bird Recording"
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Description{" "}
              <span className="text-slate-400">(optional)</span>
            </label>

            <textarea
              value={formData.description}
              onChange={handleDescriptionChange}
              placeholder="Add a description for this project..."
              rows={3}
              className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Audio File <span className="text-red-500">*</span>
            </label>

            <div className="relative">
              <input
                type="file"
                accept=".wav,.mp3,.flac,.ogg,.webm,.m4a"
                // accept="*/*"
                onChange={handleFileChange}
                disabled={loading}
                className="sr-only"
                id="audio-file-input"
              />

              <label
                htmlFor="audio-file-input"
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-3 transition hover:border-slate-400 hover:bg-slate-100"
              >
                <Upload className="h-4 w-4 text-slate-600" />
                <span className="text-sm text-slate-600">
                  {filePreview ? "Change file" : "Click to upload"}
                </span>
              </label>

              <p className="mt-1 text-xs text-slate-500">
                WAV, MP3, FLAC, OGG, WebM, M4A
              </p>
            </div>

            {filePreview && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-emerald-900">
                      {filePreview.name}
                    </p>
                    <p className="mt-0.5 text-xs text-emerald-700">
                      Format: {filePreview.format}
                    </p>
                    <p className="text-xs text-emerald-700">
                      Size: {filePreview.size} KB
                    </p>
                    {filePreview.duration && (
                      <p className="text-xs text-emerald-700">
                        Duration: {filePreview.duration}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setFormData((prev) => ({
                        ...prev,
                        audioFile: null,
                        audioDuration: null,
                      }));
                      setFilePreview(null);

                      const input =
                        document.getElementById("audio-file-input");
                      if (input) input.value = "";
                    }}
                    className="text-xs font-medium text-emerald-600 hover:text-emerald-700"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 rounded-lg border border-slate-200 px-4 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={loading || !formData.audioFile}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {loading ? "Uploading..." : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
