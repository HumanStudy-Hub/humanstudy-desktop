import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('protocol_report',ROOT/'pack/skills/run/protocol_report.py')
report=importlib.util.module_from_spec(spec);spec.loader.exec_module(report)

class ReportCites(unittest.TestCase):
    def test_lists_and_named_maps_retain_all_pages_and_files(self):
        cites=[{'source':'paper','page':6},{'source':'supplement','page':2}]
        self.assertEqual(report.citations({'first':cites[:1],'second':cites[1:]}),cites)
        protocol={'id':'test','meta':{'sources':{'paper':{'file':'paper.pdf'},'supplement':{'file':'sources/open/appendix.pdf'}}},
                  'analysis':{'effects':[{'id':'e','compute':{'op':'proportion_difference'},'reported':{'value':.13,'cite':cites}}]}}
        rows=report.rows(protocol,{'pooled':[]})
        self.assertEqual(rows[0]['cites'],cites)
        html=report.page(protocol,{'participants':{},'evaluation':{}},rows,None,False,'en')
        self.assertIn('data-page="6" data-file="paper.pdf"',html)
        self.assertIn('data-page="2" data-file="sources/open/appendix.pdf"',html)

if __name__=='__main__':unittest.main()
