'use client';

interface ConclusionProps {
  text: string;
  accentColor?: string;
}

export default function Conclusion({
  text,
  accentColor = 'var(--accent-brand)',
}: ConclusionProps) {
  const lines = text.split('\n').filter((line) => line.trim());

  return (
    <div className="mt-5 md:mt-6">
      {/* Double-bezel conclusion box */}
      <div
        className="rounded-2xl p-[1.5px] overflow-hidden"
        style={{
          background: `linear-gradient(160deg, ${accentColor}30, rgba(255,255,255,0.06) 40%, rgba(255,255,255,0.06) 60%, ${accentColor}15)`,
        }}
      >
        <div
          className="rounded-[13px] overflow-hidden relative"
          style={{
            background: `linear-gradient(160deg, ${accentColor}08, ${accentColor}03)`,
          }}
        >
          {/* Top accent bar */}
          <div
            className="h-[2px] w-full"
            style={{ background: `linear-gradient(90deg, ${accentColor}, ${accentColor}50, transparent)` }}
          />

          {/* Inner glow orb */}
          <div
            className="absolute top-0 right-0 w-36 h-36 rounded-full opacity-[0.08] pointer-events-none blur-3xl"
            style={{ background: accentColor }}
          />

          <div className="relative p-5 md:p-6">
            <h3 className="text-sm md:text-base font-semibold text-foreground mb-3.5 flex items-center gap-2.5">
              <span
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs"
                style={{
                  background: `${accentColor}15`,
                  color: accentColor,
                  border: `1px solid ${accentColor}20`,
                }}
              >
                ✓
              </span>
              <span>3行字终极结论</span>
            </h3>
            <div className="space-y-3">
              {lines.map((line, index) => (
                <p
                  key={index}
                  className="text-foreground-secondary leading-relaxed text-sm text-pretty pl-1"
                >
                  {line}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
