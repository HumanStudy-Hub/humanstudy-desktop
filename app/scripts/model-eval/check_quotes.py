"""Read-only independent grounding check; records paths and counts, never rewrites quotes."""
import argparse,json,hashlib
from pathlib import Path
import pypdfium2 as pdfium
p=argparse.ArgumentParser();p.add_argument('project');args=p.parse_args();root=Path(args.project)
doc=json.loads((root/'program.json').read_text());pdf=pdfium.PdfDocument((root/'paper.pdf').read_bytes())
def canon(s):return ''.join(s.split()).casefold().replace('\u00ad','')
pages=[]
for page in pdf:
 t=page.get_textpage();pages.append(canon(t.get_text_range()));t.close();page.close()
results=[]
for i,e in enumerate(doc.get('evidence',[])):
 if not isinstance(e,dict) or not isinstance(e.get('quote'),str):continue
 quote=canon(e['quote']);loc=e.get('locator') or {};page=loc.get('page',e.get('page'));found=[i+1 for i,text in enumerate(pages) if quote and quote in text]
 results.append({'evidenceId':e.get('id'),'claimedPage':page,'matchingPages':found,'exactOnClaimedPage':isinstance(page,int) and page in found})
report={'method':'Whitespace/case/soft-hyphen canonical substring; does not adjudicate OCR or punctuation changes. Missing exact matches require review, not automatic rejection.','evidenceCount':len(results),'exactOnClaimedPage':sum(x['exactOnClaimedPage'] for x in results),'items':results,'programSha256':hashlib.sha256((root/'program.json').read_bytes()).hexdigest()}
(root/'quote-grounding-report.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='items'}))
