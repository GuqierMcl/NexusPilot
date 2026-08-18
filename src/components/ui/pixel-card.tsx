import {
    useCallback,
    useEffect,
    useRef,
    type CSSProperties,
    type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

interface PixelCardProps {
    children: ReactNode;
    className?: string;
    colors?: readonly string[];
    gap?: number;
    speed?: number;
    style?: CSSProperties;
    /** Uses a predefined color and motion preset; unknown values fall back to default. */
    variant?: string;
}

class Pixel {
    readonly #x: number;
    readonly #y: number;
    readonly #color: string;
    readonly #speed: number;
    readonly #delay: number;
    readonly #sizeStep = Math.random() * 0.4;
    readonly #minSize = 0.5;
    readonly #maxSize = 0.5 + Math.random() * 1.5;
    #size = 0;
    #counter = 0;
    #counterStep: number;
    #reverse = false;
    #shimmer = false;
    isIdle = false;

    constructor(
        x: number,
        y: number,
        color: string,
        speed: number,
        delay: number,
        width: number,
        height: number,
    ) {
        this.#x = x;
        this.#y = y;
        this.#color = color;
        this.#speed = speed;
        this.#delay = delay;
        this.#counterStep = Math.random() * 4 + (width + height) * 0.01;
    }

    appear(context: CanvasRenderingContext2D): void {
        this.isIdle = false;
        if (this.#counter <= this.#delay) {
            this.#counter += this.#counterStep;
            return;
        }
        if (this.#size >= this.#maxSize) {
            this.#shimmer = true;
        }
        if (this.#shimmer) {
            this.#shimmerStep();
        } else {
            this.#size += this.#sizeStep;
        }
        this.#draw(context);
    }

    disappear(context: CanvasRenderingContext2D): void {
        this.#shimmer = false;
        this.#counter = 0;
        if (this.#size <= 0) {
            this.isIdle = true;
            return;
        }
        this.#size -= 0.1;
        this.#draw(context);
    }

    #draw(context: CanvasRenderingContext2D): void {
        const centerOffset = 1 - this.#size * 0.5;
        context.fillStyle = this.#color;
        context.fillRect(
            this.#x + centerOffset,
            this.#y + centerOffset,
            this.#size,
            this.#size,
        );
    }

    #shimmerStep(): void {
        if (this.#size >= this.#maxSize) {
            this.#reverse = true;
        } else if (this.#size <= this.#minSize) {
            this.#reverse = false;
        }
        this.#size += this.#reverse ? -this.#speed : this.#speed;
    }
}

const PIXEL_CARD_VARIANTS = {
    default: {
        colors: ["#f8fafc", "#f1f5f9", "#cbd5e1"],
        gap: 5,
        speed: 0.035,
    },
    blue: {
        colors: ["#e0f2fe", "#7dd3fc", "#0ea5e9"],
        gap: 10,
        speed: 0.025,
    },
    yellow: {
        colors: ["#fef08a", "#fde047", "#eab308"],
        gap: 3,
        speed: 0.02,
    },
    pink: {
        colors: ["#fecdd3", "#fda4af", "#e11d48"],
        gap: 6,
        speed: 0.08,
    },
} as const;

/**
 * A restrained, hover-triggered pixel field for compact premium surfaces.
 * Canvas is presentation-only and never receives pointer or keyboard input.
 */
function PixelCard({
    children,
    className,
    colors,
    gap,
    speed,
    style,
    variant = "default",
}: PixelCardProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const pixelsRef = useRef<Pixel[]>([]);
    const animationFrameRef = useRef<number | null>(null);
    const previousTimeRef = useRef(0);
    const reducedMotionRef = useRef(false);
    const preset = PIXEL_CARD_VARIANTS[variant as keyof typeof PIXEL_CARD_VARIANTS] ?? PIXEL_CARD_VARIANTS.default;
    const finalColors = colors ?? preset.colors;
    const finalGap = gap ?? preset.gap;
    const finalSpeed = speed ?? preset.speed;

    const initializePixels = useCallback((): void => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const { width, height } = container.getBoundingClientRect();
        const canvasWidth = Math.floor(width);
        const canvasHeight = Math.floor(height);
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;

        const pixels: Pixel[] = [];
        for (let x = 0; x < canvasWidth; x += finalGap) {
            for (let y = 0; y < canvasHeight; y += finalGap) {
                const color = finalColors[Math.floor(Math.random() * finalColors.length)];
                const distance = Math.hypot(x - canvasWidth / 2, y - canvasHeight / 2);
                pixels.push(
                    new Pixel(
                        x,
                        y,
                        color ?? PIXEL_CARD_VARIANTS.default.colors[0],
                        reducedMotionRef.current ? 0 : finalSpeed,
                        reducedMotionRef.current ? 0 : distance,
                        canvasWidth,
                        canvasHeight,
                    ),
                );
            }
        }
        pixelsRef.current = pixels;
    }, [finalColors, finalGap, finalSpeed]);

    const stopAnimation = useCallback((): void => {
        if (animationFrameRef.current !== null) {
            window.cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
    }, []);

    const animate = useCallback(
        (phase: "appear" | "disappear"): void => {
            const canvas = canvasRef.current;
            const context = canvas?.getContext("2d");
            if (!canvas || !context) return;

            const now = performance.now();
            if (now - previousTimeRef.current >= 1000 / 60) {
                previousTimeRef.current = now;
                context.clearRect(0, 0, canvas.width, canvas.height);
                let allIdle = true;
                for (const pixel of pixelsRef.current) {
                    pixel[phase](context);
                    allIdle &&= pixel.isIdle;
                }
                if (phase === "disappear" && allIdle) {
                    animationFrameRef.current = null;
                    return;
                }
            }
            animationFrameRef.current = window.requestAnimationFrame(() => animate(phase));
        },
        [],
    );

    const startAnimation = useCallback(
        (phase: "appear" | "disappear"): void => {
            if (reducedMotionRef.current) return;
            stopAnimation();
            previousTimeRef.current = performance.now();
            animationFrameRef.current = window.requestAnimationFrame(() => animate(phase));
        },
        [animate, stopAnimation],
    );

    useEffect(() => {
        reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        initializePixels();
        const observer = new ResizeObserver(initializePixels);
        const container = containerRef.current;
        if (container) observer.observe(container);
        return () => {
            observer.disconnect();
            stopAnimation();
        };
    }, [initializePixels, stopAnimation]);

    return (
        <div
            ref={containerRef}
            className={cn("group relative isolate overflow-hidden", className)}
            style={style}
            onMouseEnter={() => startAnimation("appear")}
            onMouseLeave={() => startAnimation("disappear")}
        >
            <canvas
                ref={canvasRef}
                className="pointer-events-none absolute inset-0 size-full"
                aria-hidden="true"
            />
            <div className="relative z-10">{children}</div>
        </div>
    );
}

export { PixelCard };
