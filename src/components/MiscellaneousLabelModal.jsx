import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import audioSetOntology from "../data/audioset-ontology.json";

const byId = new Map(audioSetOntology.map((item) => [item.id, item]));
const ROOT_NAMES = ["Human sounds", "Animal", "Music", "Wind", "Thunderstorm", "Rain", "Ocean"];
const roots = ROOT_NAMES.map((name) => audioSetOntology.find((x) => x.name === name)).filter(Boolean);
const childrenOf = (item) => (item?.child_ids || []).map((id) => byId.get(id)).filter(Boolean);
const selectable = (item) => item && !(item.restrictions || []).includes("abstract");

export default function MiscellaneousLabelModal({ onSelect, onClose }) {
    const [search, setSearch] = useState("");
    const [path, setPath] = useState([]);
    const current = path.length ? byId.get(path[path.length - 1]) : null;
    const browseItems = current ? childrenOf(current) : roots;

    const results = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return [];
        return audioSetOntology.filter((item) => selectable(item) && item.name.toLowerCase().includes(q));
    }, [search]);

    const openOrSelect = (item) => {
        if (childrenOf(item).length) setPath((prev) => [...prev, item.id]);
        else if (selectable(item)) onSelect(item);
    };

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
            <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
                    <div>
                        <h2 className="text-xl font-semibold text-slate-800">Select Predefined Sound</h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Browse or search predefined sound labels derived from the AudioSet ontology.
                        </p>
                    </div>
                    <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="p-6">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search sounds..."
                            className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
                    </div>

                    {!search.trim() && (
                        <div className="mt-4 flex flex-wrap gap-1 text-xs text-slate-500">
                            <button type="button" onClick={() => setPath([])} className="rounded px-2 py-1 hover:bg-slate-100">All sounds</button>
                            {path.map((id, index) => (
                                <span key={id} className="flex items-center gap-1">
                                    <span>/</span>
                                    <button type="button" onClick={() => setPath(path.slice(0, index + 1))}
                                        className="rounded px-2 py-1 hover:bg-slate-100">
                                        {byId.get(id)?.name}
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}

                    <div className="mt-4 max-h-[420px] overflow-y-auto rounded-xl border border-slate-200">
                        {(search.trim() ? results : browseItems).map((item) => {
                            const children = childrenOf(item);
                            return (
                                <div key={item.id} className="flex items-center border-b border-slate-100 last:border-b-0">
                                    <button type="button" onClick={() => openOrSelect(item)}
                                        className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-medium text-slate-700">{item.name}</span>
                                            <span className="mt-0.5 block truncate text-xs text-slate-400">{item.description}</span>
                                        </span>
                                        <span className="shrink-0 text-xs text-indigo-500">{children.length ? "Browse ›" : "Select"}</span>
                                    </button>
                                    {children.length > 0 && selectable(item) && (
                                        <button type="button" onClick={() => onSelect(item)}
                                            className="mr-3 rounded-lg px-2.5 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50">
                                            Select
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        {(search.trim() ? results : browseItems).length === 0 && (
                            <div className="px-4 py-10 text-center text-sm text-slate-400">No sounds found.</div>
                        )}
                    </div>

                    <p className="mt-4 text-xs text-slate-400">
                        AudioSet ontology attribution: Google AudioSet, CC BY-SA 4.0.
                    </p>
                </div>
            </div>
        </div>
    );
}
