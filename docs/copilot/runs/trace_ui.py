"""Trace real signed-in copilot UI. No approval or secret capture."""
from __future__ import annotations
import argparse, json, time, urllib.request
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
SENSITIVE = {'continuation','session','token','access_token','approvalToken','approval_token','signature','xdr','unsigned_xdr','signed_xdr','authorization','cookie'}
def scrub(value):
    if isinstance(value,dict):
        return {k:('[redacted]' if k.lower() in {s.lower() for s in SENSITIVE} or 'secret' in k.lower() or 'token' in k.lower() or 'xdr' in k.lower() else scrub(v)) for k,v in value.items()}
    if isinstance(value,list): return [scrub(x) for x in value]
    return value

def health():
    start=time.monotonic()
    try:
        with urllib.request.urlopen('http://127.0.0.1:3000/api/copilot',timeout=15) as r:
            return {'elapsedMs':round((time.monotonic()-start)*1000),'data':json.load(r)}
    except Exception as e:return {'error':str(e)}

ap=argparse.ArgumentParser()
ap.add_argument('--prompt')
ap.add_argument('--name',default='surface')
ap.add_argument('--reload',action='store_true')
ap.add_argument('--continue-thread',action='store_true')
ap.add_argument('--approve',action='store_true',help='Click the displayed testnet approval once; never sign a wallet popup automatically')
args=ap.parse_args()
row={'at':datetime.now(timezone.utc).isoformat(),'prompt':args.prompt,'requests':[],'responses':[],'failures':[],'before':health()}
path=ROOT/(args.name+'.json')
def save():path.write_text(json.dumps(row,indent=2),encoding='utf-8')
with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    context=browser.contexts[0]
    page=next((pg for pg in context.pages if '/copilot' in pg.url),None)
    if page is None:
        page=next((pg for pg in context.pages if pg.url.startswith('chrome-error:')),None) or context.new_page()
        page.goto('http://localhost:3000/copilot',wait_until='domcontentloaded',timeout=90000)
    elif args.reload: page.reload(wait_until='domcontentloaded',timeout=90000)
    page.wait_for_selector('textarea[aria-label="Copilot intent"]',timeout=60000)
    page.wait_for_function("() => { const el=document.querySelector('textarea[aria-label=\"Copilot intent\"]'); return el && Object.keys(el).some(k=>k.startsWith('__reactProps')); }",timeout=60000)
    page.wait_for_timeout(2000)
    row['initialBody']=page.locator('body').inner_text()
    row['url']=page.url
    def request(req):
        if '/api/copilot' in req.url and req.method=='POST':
            try: data=req.post_data_json
            except Exception: data=None
            row['requests'].append({'url':req.url,'method':req.method,'body':scrub(data)})
            save()
    def response(res):
        if '/api/copilot' in res.url and res.request.method=='POST':
            try:
                raw=res.text()
                try: data=json.loads(raw)
                except Exception: data=[json.loads(line) for line in raw.splitlines() if line.strip()]
                row['responses'].append({'url':res.url,'status':res.status,'data':scrub(data)})
            except Exception as e:row['responses'].append({'url':res.url,'status':res.status,'contentType':res.headers.get('content-type'),'error':str(e)})
            save()
    page.on('request',request)
    page.on('response',response)
    page.on('requestfailed',lambda req:row['failures'].append({'url':req.url,'failure':req.failure}) if '/api/copilot' in req.url else None)
    if args.prompt:
        if not args.continue_thread:
            button=page.get_by_role('button',name='Start over',exact=True)
            if button.count():button.first.click();page.wait_for_timeout(500)
        field=page.locator('textarea[aria-label="Copilot intent"]')
        field.fill(args.prompt)
        with page.expect_request(lambda r:'/api/copilot/investigate' in r.url and r.method=='POST',timeout=20000):
            field.evaluate('(el)=>el.form.requestSubmit()')
        t=time.monotonic()
        while time.monotonic()-t<135:
            page.wait_for_timeout(1000)
            done=any('/investigate' in r['url'] for r in row['responses'])
            if done:
                page.wait_for_timeout(7000)
                break
        row['elapsedMs']=round((time.monotonic()-t)*1000)
    if args.approve:
        row['preApprovalBody']=page.locator('body').inner_text()
        page.get_by_role('button',name='Approve and run',exact=True).click(timeout=10000)
        t=time.monotonic()
        while time.monotonic()-t<90:
            page.wait_for_timeout(1000)
            body=page.locator('body').inner_text()
            if any(x in body.lower() for x in ('sign in wallet','open your wallet','transaction failed','workflow expired','plan expired','execution complete','all steps completed')): break
        row['approvalElapsedMs']=round((time.monotonic()-t)*1000)
    row['body']=page.locator('body').inner_text()
    row['researchState']=scrub(page.evaluate("() => Object.keys(sessionStorage).filter(k => k.startsWith('vanna.copilot.thread.')).map(k => JSON.parse(sessionStorage.getItem(k)).result)"))
    row['after']=health()
    page.screenshot(path=str(ROOT/(args.name+'.png')),full_page=True)
    save()
    print(json.dumps({'path':str(path),'url':page.url,'before':row['before'],'after':row['after'],'body':row['body'][:14000],'requests':row['requests']},ensure_ascii=True))
