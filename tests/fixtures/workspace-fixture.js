const cues = [
  {start: 0, end: 12, en: 'Welcome to asynchronous JavaScript.', th: 'ยินดีต้อนรับสู่บทเรียน asynchronous JavaScript'},
  {start: 12, end: 28, en: 'A Promise represents a future result.', th: 'Promise แทนผลลัพธ์ที่จะได้รับในอนาคต'},
  {start: 28, end: 42, en: 'Use await to wait for the result.', th: 'ใช้ await เพื่อรอผลลัพธ์จาก Promise'},
  {start: 42, end: 57, en: 'Catch errors and show a helpful message.', th: 'ดักจับข้อผิดพลาด แล้วแสดงข้อความที่ช่วยให้แก้ไขได้'},
  {start: 57, end: 72, en: 'Keep the original code unchanged.', th: ''},
];
let offline = false;
const jobs = [
  {id: 'a'.repeat(20), title: '01 — Introduction to asynchronous JavaScript', course: 'JavaScript Masterclass', status: 'queued'},
  {id: 'b'.repeat(20), title: '02 — Promise และการจัดการข้อผิดพลาด', course: 'JavaScript Masterclass', status: 'error', error: 'คำแปลยังขาด 2/10 บรรทัดหลังลองซ่อม กดลองใหม่ได้จากคิว'},
  {id: 'c'.repeat(20), title: '03 — บทเรียนที่แปลเสร็จแล้ว', course: 'JavaScript Masterclass', status: 'done'},
];
async function send(message) {
  if (offline) return {ok: false, error: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ เปิด start-server.cmd แล้วกดรีเฟรช'};
  if (message.type === 'jobAction') {
    const job = jobs.find(job => job.id === message.jobId);
    job.status = message.action === 'cancel' ? 'cancelled' : 'queued';
    return {ok: true, data: {status: job.status}};
  }
  return {ok: true, data: {queued: jobs.filter(j => j.status === 'queued').length, running: null, done: jobs.filter(j => j.status === 'done').length, failed: jobs.filter(j => j.status === 'error').length, jobs}};
}
const workspace = UDTH.createWorkspace({getCues: () => cues, getTitle: () => 'Async / Await — เรียนรู้การทำงานที่ไม่ต้องรอทีละขั้น', seek: time => {document.getElementById('seek').textContent = `ตำแหน่งล่าสุด: ${time} วินาที`;}, send});
document.getElementById('open').onclick = () => workspace.open();
document.getElementById('offline').onclick = event => {offline = !offline; event.target.textContent = offline ? 'คืนการเชื่อมต่อเซิร์ฟเวอร์' : 'จำลองเซิร์ฟเวอร์ขัดข้อง';};
workspace.open();
setInterval(() => {document.getElementById('metrics').textContent = `Viewport ${innerWidth}px · document width ${document.documentElement.scrollWidth}px`;}, 500);
