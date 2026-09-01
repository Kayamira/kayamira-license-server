export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {headers:{
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Headers":"Content-Type, Authorization",
        "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
      }});
    }

    try {
      if (url.pathname === "/" || url.pathname === "/admin") {
        return new Response(adminPage(), {
          headers: {"Content-Type":"text/html;charset=UTF-8"}
        });
      }

      if (url.pathname === "/api/activate" && request.method === "POST") {
        const body = await request.json();
        return await activate(body, env);
      }

      if (url.pathname === "/api/status") {
        return await status(url.searchParams.get("device"), env);
      }

      if (url.pathname.startsWith("/api/licenses")) {
        if (!authorized(request, env)) return json({error:"Unauthorized"},401);
        return await licenseAPI(request, env, url);
      }

      if (url.pathname === "/api/products") {
        const device=url.searchParams.get("device");
        if (!(await licensed(device,env))) return json({error:"LICENSE_REQUIRED"},403);
        await setup(env);
        const r=await env.DB.prepare("SELECT * FROM products ORDER BY name").all();
        return json(r.results);
      }

      if (url.pathname === "/api/sales") {
        const device=url.searchParams.get("device");
        if (!(await licensed(device,env))) return json({error:"LICENSE_REQUIRED"},403);
        await setup(env);
        const r=await env.DB.prepare("SELECT * FROM sales ORDER BY id DESC LIMIT 100").all();
        return json(r.results);
      }

      if (url.pathname === "/api/dashboard") {
        const device=url.searchParams.get("device");
        if (!(await licensed(device,env))) return json({error:"LICENSE_REQUIRED"},403);
        await setup(env);
        const today=new Date().toISOString().slice(0,10);
        const s=await env.DB.prepare(
          "SELECT COALESCE(SUM(total),0) sales, COALESCE(SUM(profit),0) profit, COUNT(*) transactions FROM sales WHERE substr(created_at,1,10)=?"
        ).bind(today).first();
        const l=await env.DB.prepare("SELECT COUNT(*) count FROM products WHERE stock<=low_stock").first();
        return json({sales:s.sales||0,profit:s.profit||0,transactions:s.transactions||0,lowStock:l.count||0});
      }

      if (url.pathname === "/api/product" && request.method === "POST") {
        const b=await request.json();
        if (!(await licensed(b.device,env))) return json({error:"LICENSE_REQUIRED"},403);
        await setup(env);
        await env.DB.prepare(
          "INSERT INTO products(name,sku,cost,price,stock,low_stock) VALUES(?,?,?,?,?,?)"
        ).bind(b.name,b.sku||"",Number(b.cost||0),Number(b.price||0),Number(b.stock||0),Number(b.low_stock||5)).run();
        return json({ok:true});
      }

      if (url.pathname === "/api/sale" && request.method === "POST") {
        const b=await request.json();
        if (!(await licensed(b.device,env))) return json({error:"LICENSE_REQUIRED"},403);
        await setup(env);
        if (!b.items?.length) return json({error:"No items"},400);
        let total=0,profit=0;
        for (const item of b.items) {
          const p=await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(item.product_id).first();
          if (!p) return json({error:"Product not found"},400);
          const q=Number(item.qty||1);
          if (p.stock<q) return json({error:`Not enough stock for ${p.name}`},400);
          total+=p.price*q; profit+=(p.price-p.cost)*q;
          await env.DB.prepare("UPDATE products SET stock=stock-? WHERE id=?").bind(q,p.id).run();
        }
        await env.DB.prepare(
          "INSERT INTO sales(total,profit,payment_method) VALUES(?,?,?)"
        ).bind(total,profit,b.payment_method||"Cash").run();
        return json({ok:true,total,profit});
      }

      return new Response("Kayamira License Server",{status:404});
    } catch(e) {
      console.error(e);
      return json({error:e.message},500);
    }
  }
};

function authorized(request,env) {
  return (request.headers.get("Authorization")||"") === `Bearer ${env.ADMIN_TOKEN}`;
}

function makeKey() {
  const x=crypto.randomUUID().replaceAll("-","").toUpperCase();
  return `KAYA-${x.slice(0,4)}-${x.slice(4,8)}-${x.slice(8,12)}-${x.slice(12,16)}`;
}

function expiry(plan,base=new Date()) {
  if(plan==="lifetime") return null;
  const d=new Date(base);
  if(plan==="1_month") d.setMonth(d.getMonth()+1);
  else if(plan==="6_months") d.setMonth(d.getMonth()+6);
  else if(plan==="1_year") d.setFullYear(d.getFullYear()+1);
  else return null;
  return d.toISOString();
}

async function setup(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS products(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,sku TEXT,
    cost REAL NOT NULL DEFAULT 0,price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,low_stock INTEGER NOT NULL DEFAULT 5,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sales(
    id INTEGER PRIMARY KEY AUTOINCREMENT,total REAL NOT NULL,
    profit REAL NOT NULL DEFAULT 0,payment_method TEXT DEFAULT 'Cash',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
}

async function licenseAPI(request,env,url) {
  const path=url.pathname;
  if(request.method==="GET" && path==="/api/licenses") {
    const r=await env.DB.prepare("SELECT * FROM licenses ORDER BY id DESC").all();
    return json({success:true,licenses:r.results});
  }
  if(request.method==="POST" && path==="/api/licenses") {
    const b=await request.json(), customer=String(b.customer_name||"").trim();
    const plan=String(b.plan||"1_month"), max=Math.max(1,Number(b.max_devices||1));
    if(!customer) return json({error:"Customer name is required"},400);
    if(!["1_month","6_months","1_year","lifetime"].includes(plan)) return json({error:"Invalid plan"},400);
    const key=makeKey(), exp=expiry(plan);
    await env.DB.prepare(
      "INSERT INTO licenses(license_key,customer_name,plan,status,expires_at,max_devices) VALUES(?,?,?,'active',?,?)"
    ).bind(key,customer,plan,exp,max).run();
    return json({success:true,license_key:key,customer_name:customer,plan,expires_at:exp,max_devices:max});
  }
  const m=path.match(/^\/api\/licenses\/(\d+)\/(status|revoke)$/);
  if(request.method==="POST" && m) {
    const id=Number(m[1]);
    if(m[2]==="status") {
      const b=await request.json(), st=b.status==="active"?"active":"suspended";
      await env.DB.prepare("UPDATE licenses SET status=? WHERE id=?").bind(st,id).run();
    } else {
      await env.DB.prepare("UPDATE licenses SET status='revoked' WHERE id=?").bind(id).run();
    }
    return json({success:true});
  }
  return json({error:"Not found"},404);
}

async function activate(b,env) {
  if(!b.key||!b.device) return json({error:"License key required"},400);
  const key=String(b.key).trim().toUpperCase();
  const l=await env.DB.prepare("SELECT * FROM licenses WHERE license_key=?").bind(key).first();
  if(!l||l.status!=="active") return json({error:"Invalid or inactive license key"},400);
  if(l.expires_at&&new Date(l.expires_at)<new Date()) return json({error:"License expired"},400);
  const existing=await env.DB.prepare("SELECT * FROM device_activations WHERE license_id=? AND device_id=?").bind(l.id,b.device).first();
  if(!existing) {
    const count=await env.DB.prepare("SELECT COUNT(*) count FROM device_activations WHERE license_id=?").bind(l.id).first();
    if(Number(count.count)>=Number(l.max_devices)) return json({error:"Maximum number of devices reached"},400);
    await env.DB.prepare("INSERT INTO device_activations(license_id,device_id) VALUES(?,?)").bind(l.id,b.device).run();
  }
  await env.DB.prepare("UPDATE licenses SET activated_at=COALESCE(activated_at,CURRENT_TIMESTAMP) WHERE id=?").bind(l.id).run();
  return json({ok:true,customer:l.customer_name,plan:l.plan,expires_at:l.expires_at});
}

async function licensed(device,env) {
  if(!device) return false;
  const r=await env.DB.prepare(
    "SELECT l.* FROM licenses l JOIN device_activations d ON d.license_id=l.id WHERE d.device_id=? AND l.status='active'"
  ).bind(device).first();
  return !!(r && (!r.expires_at || new Date(r.expires_at)>=new Date()));
}

async function status(device,env) {
  if(!device) return json({licensed:false});
  const r=await env.DB.prepare(
    "SELECT l.customer_name,l.plan,l.expires_at FROM licenses l JOIN device_activations d ON d.license_id=l.id WHERE d.device_id=? AND l.status='active'"
  ).bind(device).first();
  if(!r || (r.expires_at&&new Date(r.expires_at)<new Date())) return json({licensed:false});
  return json({licensed:true,customer:r.customer_name,plan:r.plan,expires_at:r.expires_at});
}

function json(data,status=200) {
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
}

function adminPage() {
return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kayamira License Admin</title>
<style>body{font-family:Arial;background:#101719;color:white;margin:0}header{padding:20px;background:#0c1214}main{max-width:1000px;margin:auto;padding:20px}.card{background:#172124;padding:20px;border-radius:14px;margin-bottom:18px}input,select{width:100%;box-sizing:border-box;padding:12px;margin:7px 0 12px;background:#0d1416;color:white;border:1px solid #39474b;border-radius:8px}button{padding:11px 16px;border:0;border-radius:8px;background:#0fa3b1;color:white;font-weight:bold;margin:4px}table{width:100%;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #304044;text-align:left}.key{font-family:monospace}</style></head>
<body><header><h2>🔐 Kayamira License Admin</h2></header><main>
<div id="login" class="card"><h3>Administrator Login</h3><input id="token" type="password" placeholder="ADMIN TOKEN"><button onclick="login()">Login</button><p id="msg"></p></div>
<div id="app" style="display:none">
<div class="card"><h3>Create License</h3><input id="customer" placeholder="Customer / Business name"><select id="plan"><option value="1_month">1 Month</option><option value="6_months">6 Months</option><option value="1_year">1 Year</option><option value="lifetime">Lifetime</option></select><input id="devices" type="number" min="1" value="1"><button onclick="create()">Generate Key</button><div id="created"></div></div>
<div class="card"><h3>Licenses</h3><button onclick="load()">Refresh</button><div id="list"></div></div></div></main>
<script>
let T=localStorage.getItem("kay_admin")||"";
async function api(p,o={}){o.headers={...(o.headers||{}),"Authorization":"Bearer "+T,"Content-Type":"application/json"};return fetch(p,o)}
async function login(){T=document.getElementById("token").value.trim();let r=await api("/api/licenses");if(r.ok){localStorage.setItem("kay_admin",T);document.getElementById("login").style.display="none";document.getElementById("app").style.display="block";load()}else document.getElementById("msg").textContent="Invalid token."}
async function create(){let customer=document.getElementById("customer").value.trim();if(!customer)return alert("Enter customer name.");let r=await api("/api/licenses",{method:"POST",body:JSON.stringify({customer_name:customer,plan:document.getElementById("plan").value,max_devices:Number(document.getElementById("devices").value)})});let d=await r.json();if(!r.ok)return alert(d.error);document.getElementById("created").innerHTML="<h4>License created</h4><p class='key'>"+d.license_key+"</p><button onclick='navigator.clipboard.writeText(\""+d.license_key+"\")'>Copy Key</button>";document.getElementById("customer").value="";load()}
async function load(){let r=await api("/api/licenses");if(!r.ok)return;let d=await r.json();document.getElementById("list").innerHTML="<table><tr><th>Customer</th><th>Key</th><th>Plan</th><th>Status</th><th>Expiry</th><th>Action</th></tr>"+d.licenses.map(x=>"<tr><td>"+esc(x.customer_name)+"</td><td class='key'>"+esc(x.license_key)+"</td><td>"+esc(x.plan)+"</td><td>"+esc(x.status)+"</td><td>"+(x.expires_at?new Date(x.expires_at).toLocaleDateString():"Lifetime")+"</td><td><button onclick='toggle("+x.id+",\""+x.status+"\")'>"+(x.status==="active"?"Suspend":"Activate")+"</button><button onclick='revoke("+x.id+")'>Revoke</button></td></tr>").join("")+"</table>"}
async function toggle(id,s){await api("/api/licenses/"+id+"/status",{method:"POST",body:JSON.stringify({status:s==="active"?"suspended":"active"})});load()}
async function revoke(id){if(confirm("Revoke this license?")){await api("/api/licenses/"+id+"/revoke",{method:"POST"});load()}}
function esc(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
if(T)login();
</script></body></html>`;
}
