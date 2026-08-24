import { GripVertical } from "lucide-react";
import { useState, type ChangeEvent, type PointerEvent } from "react";

const lightScreenshot = "/screenshots/nexuspilot-workbench-light.png";
const darkScreenshot = "/screenshots/nexuspilot-workbench-dark.png";

export function ThemeComparisonSlider() {
  const [position, setPosition] = useState(50);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPosition(Number(event.currentTarget.value));
  };

  const handlePointerDown = (event: PointerEvent<HTMLInputElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <div className="theme-comparison-stage">
      <figure
        className="theme-comparison-frame relative isolate mx-auto aspect-[1810/1158] w-full overflow-hidden text-left"
        aria-label="NexusPilot 明暗模式工作台截图对比"
      >
        <img
          src={lightScreenshot}
          alt="NexusPilot 亮色模式工作台截图"
          className="h-full w-full select-none object-cover"
          draggable={false}
        />

        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          aria-hidden="true"
        >
          <img
            src={darkScreenshot}
            alt=""
            className="h-full w-full select-none object-cover"
            draggable={false}
          />
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 z-10"
          style={{ left: `${position}%` }}
          aria-hidden="true"
        >
          <div className="theme-comparison-divider absolute inset-y-0 -left-px" />
          <div className="theme-comparison-handle absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center">
            <GripVertical className="h-5 w-5" strokeWidth={2.4} />
          </div>
        </div>

        <input
          type="range"
          min="0"
          max="100"
          value={position}
          onChange={handleChange}
          onPointerDown={handlePointerDown}
          aria-label="调整明暗模式截图分界线"
          className="absolute inset-0 z-20 h-full w-full cursor-ew-resize opacity-0"
        />
      </figure>
    </div>
  );
}
