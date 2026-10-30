"""Tests del nodo edge (sin cámara): python3 -m unittest edge/test_edge.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from edge_daemon import Confirmador, analizar, candidatos  # noqa: E402


class TestPatentes(unittest.TestCase):
    def test_formatos(self):
        self.assertEqual(analizar("BBCC·12"), "BBCC-12")
        self.assertEqual(analizar("bb-cc-11"), "BBCC-11")
        self.assertEqual(analizar("HL 4521"), "HL-4521")
        self.assertEqual(analizar("RJKTB3"), "RJKT-83")  # corrección OCR
        self.assertIsNone(analizar("CHILE"))
        self.assertIsNone(analizar("HOLA MUNDO"))

    def test_une_textos_separados(self):
        res = [("BBCC", 0.9, (100, 50, 200, 90)), ("12", 0.88, (210, 52, 250, 90)), ("CHILE", 0.9, (130, 20, 180, 40))]
        self.assertEqual([c[0] for c in candidatos(res, 0.6)], ["BBCC-12"])

    def test_confirmacion_y_dedup(self):
        c = Confirmador(n_confirmar=2, conf_directa=0.95, dedup_s=30)
        self.assertFalse(c.registrar("BBCC-12", 0.80, ahora=100))
        self.assertTrue(c.registrar("BBCC-12", 0.82, ahora=100.5))   # 2 lecturas → confirma
        self.assertFalse(c.registrar("BBCC-12", 0.99, ahora=110))   # dentro de 30 s → no repite
        self.assertTrue(c.registrar("RJKT-83", 0.97, ahora=111))    # confianza alta → directo
        self.assertTrue(c.registrar("BBCC-12", 0.99, ahora=140))    # pasado el dedup


if __name__ == "__main__":
    unittest.main()
