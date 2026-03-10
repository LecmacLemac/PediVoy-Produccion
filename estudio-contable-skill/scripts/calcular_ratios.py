#!/usr/bin/env python3
"""Calcula ratios contables básicos desde un JSON de entrada.

Uso:
  python scripts/calcular_ratios.py --input datos.json
  cat datos.json | python scripts/calcular_ratios.py

Formato JSON esperado (claves opcionales según ratio):
{
  "activo_corriente": 0,
  "pasivo_corriente": 0,
  "bienes_cambio": 0,
  "activo_total": 0,
  "pasivo_total": 0,
  "patrimonio_neto": 0,
  "resultado_bruto": 0,
  "resultado_operativo": 0,
  "resultado_neto": 0,
  "ventas": 0,
  "gastos_operativos": 0,
  "activo_total_promedio": 0,
  "patrimonio_neto_promedio": 0
}
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, Optional


def to_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def safe_div(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b in (None, 0):
        return None
    return a / b


def compute_ratios(d: Dict[str, Any]) -> Dict[str, Optional[float]]:
    ac = to_float(d.get("activo_corriente"))
    pc = to_float(d.get("pasivo_corriente"))
    bc = to_float(d.get("bienes_cambio")) or 0.0

    at = to_float(d.get("activo_total"))
    pt = to_float(d.get("pasivo_total"))
    pn = to_float(d.get("patrimonio_neto"))

    rb = to_float(d.get("resultado_bruto"))
    rop = to_float(d.get("resultado_operativo"))
    rn = to_float(d.get("resultado_neto"))
    ventas = to_float(d.get("ventas"))
    gop = to_float(d.get("gastos_operativos"))

    atp = to_float(d.get("activo_total_promedio")) or at
    pnp = to_float(d.get("patrimonio_neto_promedio")) or pn

    ratios = {
        # Liquidez
        "liquidez_corriente": safe_div(ac, pc),
        "prueba_acida": safe_div((ac - bc) if ac is not None else None, pc),
        "capital_trabajo": (ac - pc) if (ac is not None and pc is not None) else None,
        # Endeudamiento / solvencia
        "endeudamiento_total": safe_div(pt, at),
        "pasivo_sobre_patrimonio": safe_div(pt, pn),
        "solvencia": safe_div(at, pt),
        # Rentabilidad
        "margen_bruto": safe_div(rb, ventas),
        "margen_operativo": safe_div(rop, ventas),
        "margen_neto": safe_div(rn, ventas),
        "roa": safe_div(rn, atp),
        "roe": safe_div(rn, pnp),
        # Eficiencia
        "rotacion_activos": safe_div(ventas, atp),
        "peso_gastos_operativos": safe_div(gop, ventas),
    }

    return ratios


def load_input(path: Optional[str]) -> Dict[str, Any]:
    if path:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return json.load(sys.stdin)


def main() -> int:
    parser = argparse.ArgumentParser(description="Calcular ratios contables desde JSON")
    parser.add_argument("--input", "-i", help="Ruta al archivo JSON de entrada")
    parser.add_argument(
        "--pretty", action="store_true", help="Imprimir JSON formateado"
    )
    args = parser.parse_args()

    try:
        data = load_input(args.input)
        ratios = compute_ratios(data)
    except json.JSONDecodeError as e:
        print(f"JSON inválido: {e}", file=sys.stderr)
        return 2
    except FileNotFoundError as e:
        print(f"Archivo no encontrado: {e}", file=sys.stderr)
        return 2

    if args.pretty:
        print(json.dumps(ratios, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(ratios, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
