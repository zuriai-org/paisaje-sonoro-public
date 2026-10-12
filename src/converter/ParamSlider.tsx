import { useEffect, useState } from "react";

interface ParamSliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  /** Texto de ayuda breve bajo el parámetro (corrección fase 6). */
  help?: string;
  /** Deshabilita slider e input (p. ej. tarjetas de referencia no activas). */
  disabled?: boolean;
}

/** Formatea sin ruido de float: 4 decimales máx. y sin ceros sobrantes. */
function formatNum(v: number): string {
  return String(parseFloat(v.toFixed(4)));
}

/**
 * Slider + input numérico sincronizados bidireccionalmente
 * (patrón heredado de la app Python, con validación de rango real:
 * el input numérico se clampa a [min, max] al confirmar y el slider
 * lo está por construcción).
 */
export function ParamSlider({ label, min, max, step, value, onChange, help, disabled = false }: ParamSliderProps) {
  const [text, setText] = useState(formatNum(value));

  // Si el valor cambia desde fuera (🎲 seed, regeneración), sincroniza el texto.
  useEffect(() => {
    setText(formatNum(value));
  }, [value]);

  const commitText = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isNaN(v)) {
      setText(formatNum(value)); // inválido → revertir
      return;
    }
    const clamped = Math.min(max, Math.max(min, v));
    onChange(clamped); // el useEffect de arriba sincroniza el texto si se clampó
  };

  return (
    <div className="paisaje-param">
      <span className="paisaje-param-label">{label}</span>
      <div className="paisaje-param-controls">
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <input
          type="number"
          className="paisaje-param-num"
          aria-label={`${label} (valor numérico)`}
          min={min}
          max={max}
          step={step}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commitText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText((e.target as HTMLInputElement).value);
          }}
        />
      </div>
      {help && <p className="paisaje-help">{help}</p>}
    </div>
  );
}
