import { AudioWaveform } from 'lucide-react';

const Logo = () => {
  return (
    <div className="flex items-center justify-center gap-2">
      <AudioWaveform className="w-7 h-7 text-indigo-600" strokeWidth={2.5} />
      <span className="text-xl font-bold text-slate-900">
        Audio<span className="text-indigo-600">Mark</span>
      </span>
    </div>
  );
};

export default Logo;