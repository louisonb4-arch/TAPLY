import { chromium } from 'playwright';

const browser = await chromium.launch({headless:true});
try {
  for (const [formFactor,width,height] of [['desktop',1440,900],['mobile',390,844]]) {
    const page = await browser.newPage({viewport:{width,height}});
    const errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    const setup = {
      programId:'11111111-1111-4111-8111-111111111111',
      merchantName:'Café Quartier',name:'Carte de fidélité',threshold:7,
      rewardTitle:'Un espresso offert',rewardTerms:'1 passage par achat éligible',
      cardColor:'#10241A',textColor:'#FFFFFF',published:false,hasEnrollmentLink:true,
      enrollmentUrl:null,walletAvailable:false,
    };
    await page.route('**/api/**', async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(req.method()!=='GET')writes.push({path,body:JSON.parse(req.postData()||'{}'),method:req.method()});
      const json=(obj,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(obj)});
      if(path==='/api/auth/me')return json({role:'owner',merchantId:'m1'});
      if(path==='/api/loyalty/merchant')return json({name:'Café Quartier'});
      if(path==='/api/loyalty/overview')return json({programs:[{
        id:'p1',name:'Carte de fidélité',status:'active',
        threshold:7,totalMembers:0,pendingRewards:0,
      }]});
      if(path==='/api/loyalty/customers')return json({customers:[]});
      if(path==='/api/loyalty/security')return json({devices:[],recentActivity:[],unusualVelocity:[]});
      if(path==='/api/loyalty/identity')return json({merchantUserId:'owner-1'});
      if(path==='/api/loyalty/home')return json({
        program:{name:'Carte de fidélité',status:'active',threshold:7},
        stats:{cardsRegistered:0,visitsValidated:0,rewardsPending:0,rewardsRedeemed:0},
        devices:{usableCount:0},recentActivity:[],onboarding:{steps:[],completed:0,total:4},
      });
      if(path==='/api/loyalty/setup'&&req.method()==='PATCH'){
        Object.assign(setup,JSON.parse(req.postData()));return json({saved:true});
      }
      if(path==='/api/loyalty/setup')return json(setup);
      if(path==='/api/loyalty/setup/publish')return json({error:'preview unavailable'},503);
      return json({},404);
    });
    await page.goto('http://127.0.0.1:4190/dashboard/#/demarrage',{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Lancer ma carte de fidélité'}).waitFor({timeout:9000});
    if(await page.locator('input[name=firstName]').count())throw new Error('merchant form incorrectly requests first name');
    await page.locator('input[name=rewardTitle]').fill('Un chocolat chaud offert');
    await page.locator('select[name=threshold]').selectOption('8');
    await page.getByRole('button',{name:'Enregistrer ma configuration'}).click();
    await page.getByText(/Programme enregistré/).waitFor({timeout:9000});
    const saved=writes.find(x=>x.path==='/api/loyalty/setup'&&x.method==='PATCH');
    if(!saved || saved.body.threshold!==8 || saved.body.rewardTitle!=='Un chocolat chaud offert')throw new Error('merchant save failed');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
    if(overflow>1||errors.length)throw new Error('merchant visual regression');
    console.log('MERCHANT',JSON.stringify({formFactor,saved:true,overflow,errors}));
    await page.close();
  }

  for(const [formFactor,width,height] of [['desktop',1000,820],['mobile',390,844]]) {
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    let hasCard=false;
    await page.route('**/api/**',route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(req.method()==='POST')writes.push({path,body:JSON.parse(req.postData()||'{}')});
      const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/loyalty/public-card')return json({
        merchantName:'Café Quartier',threshold:7,rewardTitle:'Un café offert',
        rewardTerms:'1 passage par achat éligible',cardColor:'#10241A',textColor:'#FFFFFF',
        card:hasCard?{membershipId:'m1',visits:0,rewardPending:false,cycleNumber:1,threshold:7}:null,
      });
      if(path==='/api/loyalty/public-card/enroll'){
        hasCard=true;
        return json({created:true,card:{membershipId:'m1',visits:0,
          rewardPending:false,cycleNumber:1,threshold:7}});
      }
      if(path==='/api/loyalty/public-card/present')return json({
        qrToken:'B'.repeat(43),
        qrSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="black"/></svg>',
        rotationPolicy:'on_next_presentation',
      });
      if(path==='/api/loyalty/public-card/recovery-code')return json({
        recoveryCode:'ABCDEFGHJKLMNPQRSTUV',shownOnce:true,
      });
      if(path==='/api/loyalty/public-card/recover')return json({recovered:true});
      return json({},404);
    });
    await page.goto('http://127.0.0.1:4190/join.html?code='+'A'.repeat(32),{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'Obtenir ma carte gratuite'}).waitFor({timeout:9000});
    if(await page.locator('[name=firstName]').count())throw new Error('client asks for name');
    await page.getByRole('button',{name:'Obtenir ma carte gratuite'}).click();
    await page.getByRole('heading',{name:'Votre carte est prête !'}).waitFor({timeout:9000});
    await page.getByRole('button',{name:'Afficher mon QR personnel'}).click();
    await page.locator('img[data-qr]:not([hidden])').waitFor({timeout:9000});
    await page.getByRole('button',{name:'Obtenir un code de récupération (facultatif)'}).click();
    await page.locator('[data-secret]:not([hidden])').waitFor({timeout:9000}).catch(async()=>{
      await page.locator('[data-secret-section]:not([hidden])').waitFor({timeout:9000});
    });
    const enrolled=writes.find(x=>x.path.endsWith('/enroll'));
    if(!enrolled||enrolled.body.privacyAccepted!==true || 'firstName' in enrolled.body)throw new Error('client enrollment payload malformed');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
    if(overflow>1||errors.length)throw new Error('client visual regression');
    console.log('CLIENT',JSON.stringify({formFactor,anonymous:true,displayQr:true,recovery:true,overflow,errors}));
    await page.close();
  }
} finally {await browser.close();}
