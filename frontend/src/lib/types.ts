export type Word = { w: string; s: number; e: number };

export type SubtitleStyle = {
  font: string;
  size: number;
  bold: boolean;
  uppercase: boolean;
  mode: "word" | "group";
  group_size: number;
  text_color: string;
  highlight_color: string;
  keyword_color: string;
  highlight_active: boolean;
  outline_color: string;
  outline: number;
  shadow: number;
  position: number;
  keywords: string[];
};

export type User = {
  id: string;
  email: string;
  display_name: string;
  plan: string;
  default_subtitle_style: Partial<SubtitleStyle> | null;
};

export type JobLog = { t: string; level: string; msg: string };

export type Job = {
  id: string;
  kind: "analyze" | "render";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  step: string;
  progress: number;
  attempts: number;
  max_attempts: number;
  error: string | null;
  clip_id: string | null;
  project_id: string;
  logs: JobLog[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type Source = {
  kind: string;
  youtube_url: string | null;
  original_filename: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  size_bytes: number | null;
  rights_confirmed: boolean;
  has_file: boolean;
  thumbnail_url: string | null;
  video_url: string | null;
};

export type ClipSummary = {
  id: string;
  project_id: string;
  project_title: string | null;
  start: number;
  end: number;
  duration: number;
  source_duration: number;
  title: string;
  score: number;
  status: "draft" | "queued" | "rendering" | "ready" | "failed";
  selection_method: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  rendered_at: string | null;
  export_url: string | null;
  thumbnail_url: string | null;
  srt_url: string | null;
};

export type ExportSettings = {
  width: number;
  height: number;
  burn_subtitles: boolean;
  normalize_audio: boolean;
  target_lufs: number;
  remove_silences: boolean;
};

export type ClipDetail = ClipSummary & {
  title_options: string[];
  hooks: string[];
  description: string;
  hashtags: string[];
  keywords: string[];
  score_breakdown: {
    subscores?: Record<string, number>;
    weights?: Record<string, number>;
    pace_measures?: Record<string, number>;
  };
  reason: string;
  thumbnail_time: number | null;
  crop_x: number | null;
  crop_auto: boolean;
  crop_shots: [number, number][] | null;
  segments: [number, number][];
  subtitles: { words: Word[]; style: SubtitleStyle; edited: boolean } | null;
  export_settings: ExportSettings | null;
  source: Source | null;
  score_disclaimer: string;
};

export type Project = {
  id: string;
  title: string;
  status: "draft" | "awaiting_upload" | "queued" | "processing" | "ready" | "failed";
  language: string;
  clip_count: number;
  min_duration: number;
  max_duration: number;
  remove_silences: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
  source: Source | null;
  has_transcript: boolean;
  transcript_provider: string | null;
  n_clips: number;
  n_ready: number;
  active_jobs: Job[];
  clips?: ClipSummary[];
};

export type SystemStatus = {
  ffmpeg: boolean;
  transcription_provider: string;
  transcription_configured: boolean;
  whisper_model: string;
  llm_provider: string;
  llm_model: string | null;
  storage: string;
  youtube_metadata: boolean;
  youtube_duration: boolean;
  fonts: string[];
  default_subtitle_style: SubtitleStyle;
};

export type Usage = {
  plan: { name: string; monthly_video_minutes: number; max_upload_mb: number; max_video_minutes: number; max_clips_per_video: number; batch_processing: boolean };
  plans: Record<string, Usage["plan"]>;
  video_minutes_used: number;
  asr_minutes: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  estimated_cost_eur: number;
  billing_enabled: boolean;
};
