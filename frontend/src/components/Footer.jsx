// src/components/Footer.jsx
import React from 'react'
import { Link } from 'react-router-dom'
import {
  FaFacebookF, FaInstagram, FaWhatsapp, FaLinkedinIn,
  FaLocationDot, FaPhone, FaEnvelope, FaClock, FaChevronRight,
} from 'react-icons/fa6'

const SOCIALS = [
  { icon:FaFacebookF, href:'#', label:'Facebook',  hover:'#1877F2' },
  { icon:FaInstagram, href:'#', label:'Instagram', hover:'linear-gradient(135deg,#f09433,#dc2743,#bc1888)' },
  { icon:FaWhatsapp,  href:'https://wa.me/918122257307', label:'WhatsApp', hover:'#25D366' },
  { icon:FaLinkedinIn,href:'#', label:'LinkedIn',  hover:'#0A66C2' },
]

const SERVICES = ['International Courier','Domestic Delivery','Air Freight','Excess Baggage','Free Pickup','Medicine Courier']

const CONTACTS = [
  { icon:FaLocationDot, val:'Chennai, Tamil Nadu, India' },
  { icon:FaPhone,       val:'+91 81222 57307', href:'tel:+918122257307' },
  { icon:FaPhone,       val:'+91 95661 22447', href:'tel:+919566122447' },
  { icon:FaEnvelope,    val:'info@garudaexpresscourier.com', href:'mailto:info@garudaexpresscourier.com' },
  { icon:FaClock,       val:'Mon–Sat: 9AM – 7PM' },
]

export default function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer style={{ backgroundColor:'#1a0820', color:'rgba(255,255,255,0.55)', position:'relative', overflow:'hidden' }}>
      {/* Signature hairline — soft glow centered on the brand accent */}
      <div style={{ position:'absolute', top:0, left:0, right:0, height:1, background:'linear-gradient(90deg,transparent,rgba(123,63,173,0.5) 50%,transparent)' }} />
      <div style={{ position:'absolute', top:-180, left:'50%', transform:'translateX(-50%)', width:480, height:360, borderRadius:'50%', background:'radial-gradient(circle,rgba(123,63,173,0.1) 0%,transparent 70%)', pointerEvents:'none' }} />

      <div style={{ maxWidth:1200, margin:'0 auto', padding:'60px 24px 40px', position:'relative' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:48, marginBottom:48 }} className="footer-grid">

          {/* Brand */}
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <img src="/assets/logo.png" alt="" style={{ width:40, height:40, borderRadius:'50%', objectFit:'cover' }} />
              <div>
                <div style={{ color:'white', fontWeight:700, fontSize:18 }}>Garuda Express</div>
                <div style={{ color:'#7B3FAD', fontSize:9, textTransform:'uppercase', letterSpacing:'0.2em', marginTop:2 }}>International</div>
              </div>
            </div>
            <p style={{ fontSize:14, lineHeight:1.8, maxWidth:300, marginBottom:20 }}>
              Your one-stop solution for domestic and international courier services across 220+ countries.
            </p>
            <div style={{ display:'flex', gap:10 }}>
              {SOCIALS.map(s => {
                const Icon = s.icon
                return (
                  <a key={s.label} href={s.href} target="_blank" rel="noreferrer" title={s.label}
                    className="footer-social"
                    style={{ width:38, height:38, borderRadius:11, backgroundColor:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', display:'flex', alignItems:'center', justifyContent:'center', color:'rgba(255,255,255,0.5)', textDecoration:'none' }}
                    onMouseEnter={e=>{ e.currentTarget.style.background=s.hover; e.currentTarget.style.borderColor='transparent'; e.currentTarget.style.color='white'; e.currentTarget.style.transform='translateY(-3px) scale(1.06)'; e.currentTarget.style.boxShadow='0 8px 18px rgba(0,0,0,0.35)' }}
                    onMouseLeave={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; e.currentTarget.style.color='rgba(255,255,255,0.5)'; e.currentTarget.style.transform='translateY(0) scale(1)'; e.currentTarget.style.boxShadow='none' }}>
                    <Icon size={14} />
                  </a>
                )
              })}
            </div>
          </div>

          {/* Services */}
          <div>
            <div style={{ color:'white', fontWeight:700, fontSize:11, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:16 }}>Services</div>
            <ul style={{ listStyle:'none', padding:0, margin:0, display:'flex', flexDirection:'column', gap:10 }}>
              {SERVICES.map(s => (
                <li key={s}>
                  <a href="/#services" className="footer-service-link" style={{ color:'rgba(255,255,255,0.5)', fontSize:14, textDecoration:'none', display:'flex', alignItems:'center', gap:6, transition:'color 0.2s' }}
                    onMouseEnter={e=>e.currentTarget.style.color='white'} onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,0.5)'}>
                    <FaChevronRight className="footer-arrow" size={9} style={{ color:'#7B3FAD', flexShrink:0 }} /> {s}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <div style={{ color:'white', fontWeight:700, fontSize:11, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:16 }}>Contact</div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              {CONTACTS.map((c,i) => {
                const Icon = c.icon
                return (
                  <div key={i} style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
                    <div style={{ width:28, height:28, borderRadius:9, backgroundColor:'rgba(123,63,173,0.15)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1 }}>
                      <Icon size={12} color="#a78bfa" />
                    </div>
                    {c.href
                      ? <a href={c.href} style={{ color:'rgba(255,255,255,0.5)', fontSize:13, textDecoration:'none', lineHeight:1.9, transition:'color 0.2s' }} onMouseEnter={e=>e.currentTarget.style.color='white'} onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,0.5)'}>{c.val}</a>
                      : <span style={{ color:'rgba(255,255,255,0.5)', fontSize:13, lineHeight:1.9 }}>{c.val}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', paddingTop:24, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
          <span style={{ fontSize:12 }}>© {year} Garuda Express International. All rights reserved.</span>
          <div style={{ display:'flex', gap:20 }}>
            <Link to="/admin" className="footer-bottom-link" style={{ color:'rgba(255,255,255,0.4)', fontSize:12, textDecoration:'none', transition:'color 0.2s' }}>Admin Portal</Link>
            <a href="#" className="footer-bottom-link" style={{ color:'rgba(255,255,255,0.4)', fontSize:12, textDecoration:'none', transition:'color 0.2s' }}>Privacy Policy</a>
            <a href="#" className="footer-bottom-link" style={{ color:'rgba(255,255,255,0.4)', fontSize:12, textDecoration:'none', transition:'color 0.2s' }}>Terms of Service</a>
          </div>
        </div>

        {/* Credit — ExploitEye branding */}
        <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', marginTop:24, paddingTop:18, display:'flex', alignItems:'center', justifyContent:'center', gap:8, flexWrap:'wrap' }}>
          <span style={{ fontSize:11.5, color:'rgba(255,255,255,0.35)', fontWeight:500, letterSpacing:'0.2px' }}>Designed &amp; developed by</span>
          <a
            href="https://exploiteye.in"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-credit-brand"
            style={{ display:'inline-flex', alignItems:'center', gap:5, textDecoration:'none' }}
          >
            <img
              src="https://exploiteye.in/logo.png"
              alt="ExploitEye"
              style={{ height:16, width:'auto', display:'block', objectFit:'contain' }}
            />
            <span style={{ fontSize:12, fontWeight:700, color:'white', letterSpacing:'-0.2px' }}>ExploitEye</span>
          </a>
        </div>
      </div>

      <style>{`
        .footer-grid{grid-template-columns:1fr!important}
        @media(min-width:640px){.footer-grid{grid-template-columns:2fr 1fr 1fr!important}}

        .footer-social{ transition: transform 0.25s cubic-bezier(.34,1.56,.64,1), background 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease, color 0.25s ease; }
        .footer-arrow{ transition: transform 0.25s cubic-bezier(.34,1.56,.64,1); }
        .footer-service-link:hover .footer-arrow{ transform: translateX(4px); }
        .footer-bottom-link:hover{ color: white !important; }

        @media (prefers-reduced-motion: reduce) {
          .footer-social, .footer-arrow { transition: none !important; }
        }
      `}</style>
    </footer>
  )
}