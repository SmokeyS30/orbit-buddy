// Study coach question bank: starter set of CompTIA-style multiple-choice
// questions (9 per exam). Each question targets one exam objective/topic and
// carries a short Professor-Messer-style explanation: why the right answer is
// right and why the others are wrong.
//
// seedStudyBank(db) inserts the bank once, when study_questions is empty —
// idempotent, additive, and safe to run at every startup. The user grows the
// bank via chat ("add a question about X" → study_add_question tool).

export const STUDY_QUESTIONS = [
  // ---------------- A+ Core 1 (220-1201) ----------------
  {
    id: 'a1-ram-ddr5', exam: 'A+ Core 1', topic: 'RAM technologies',
    question: 'A technician is upgrading a desktop that currently uses DDR4 RAM. Which statement about DDR5 is TRUE?',
    choices: [
      'DDR5 modules fit in DDR4 slots because both are 288-pin',
      'DDR5 offers higher bandwidth and runs at a lower voltage than DDR4',
      'DDR5 requires ECC on all desktop motherboards',
      'DDR5 has fewer pins than DDR4, so adapters are needed',
    ],
    correct_index: 1,
    explanation: 'DDR5 is faster (higher MT/s) and runs at 1.1V versus DDR4\'s 1.2V. The notch is in a different position, so DDR5 physically will not fit a DDR4 slot despite both being 288-pin. ECC is optional on desktop DDR5, not required.',
  },
  {
    id: 'a1-wifi-6ghz', exam: 'A+ Core 1', topic: 'Wireless standards',
    question: 'A user wants the fastest Wi-Fi including the 6 GHz band. Which standard should the new access point support?',
    choices: ['802.11n (Wi-Fi 4)', '802.11ac (Wi-Fi 5)', '802.11ax (Wi-Fi 6/6E)', '802.11g'],
    correct_index: 2,
    explanation: '802.11ax (Wi-Fi 6E) is the first standard to use the 6 GHz band, with the highest throughput here. 802.11ac is Wi-Fi 5 on 5 GHz only, 802.11n is Wi-Fi 4 on 2.4/5 GHz, and 802.11g is 2.4 GHz only and far slower.',
  },
  {
    id: 'a1-raid10', exam: 'A+ Core 1', topic: 'RAID levels',
    question: 'A small business wants disk redundancy with strong read performance on a 4-drive array and can sacrifice half the capacity. Which RAID level fits best?',
    choices: ['RAID 0', 'RAID 1', 'RAID 5', 'RAID 10'],
    correct_index: 3,
    explanation: 'RAID 10 mirrors then stripes: it survives drive failures, reads very fast, and yields 50% usable capacity. RAID 0 has no redundancy at all, RAID 1 only pairs two drives, and RAID 5 gives more usable space (n-1) but with slower writes from parity.',
  },
  {
    id: 'a1-laser-transfer', exam: 'A+ Core 1', topic: 'Laser printing process',
    question: 'During the laser printing process, toner is moved from the imaging drum onto the paper during which step?',
    choices: ['Charging', 'Exposing', 'Developing', 'Transferring'],
    correct_index: 3,
    explanation: 'Transferring is when the transfer roller moves toner from the drum to the paper. Charging conditions the drum with a charge, exposing writes the image with the laser, and developing applies toner to the drum — all before transfer.',
  },
  {
    id: 'a1-cloud-paas', exam: 'A+ Core 1', topic: 'Cloud models',
    question: 'A company wants to deploy a custom application without managing the operating system or runtime. Which cloud model fits?',
    choices: ['IaaS', 'PaaS', 'SaaS', 'DaaS'],
    correct_index: 1,
    explanation: 'PaaS provides the runtime and OS so developers just deploy code. IaaS gives raw VMs you must manage yourself, SaaS is finished software you subscribe to, and DaaS delivers virtual desktops — none match "deploy my own app without managing the OS."',
  },
  {
    id: 'a1-private-ip', exam: 'A+ Core 1', topic: 'IPv4 addressing',
    question: 'Which of these addresses can be assigned to a device on a private LAN?',
    choices: ['11.0.0.5', '172.32.0.5', '192.168.10.5', '8.8.8.8'],
    correct_index: 2,
    explanation: '192.168.10.5 falls in 192.168.0.0/16, a private range. 11.0.0.5 and 8.8.8.8 are public addresses, and 172.32.0.5 is public too — the private 172.16.0.0/12 range only covers 172.16.0.0 through 172.31.255.255.',
  },
  {
    id: 'a1-beep-video', exam: 'A+ Core 1', topic: 'Hardware troubleshooting',
    question: 'On a system with an AMI BIOS, one long beep followed by two short beeps at power-on most likely indicates a failure of the:',
    choices: ['CPU', 'System RAM', 'Video card', 'Power supply'],
    correct_index: 2,
    explanation: 'AMI\'s 1-long-2-short code means video failure — reseat or replace the GPU and check its power connectors. CPU and RAM failures use different beep codes, and a dead power supply typically gives no beeps at all.',
  },
  {
    id: 'a1-cat6a', exam: 'A+ Core 1', topic: 'Cabling',
    question: 'Which cable type supports 10 Gbps Ethernet up to the full 100-meter run?',
    choices: ['Cat5e', 'Cat6', 'Cat6a', 'RG-6'],
    correct_index: 2,
    explanation: 'Cat6a is rated for 10 Gbps to 100 meters. Cat5e tops out at 1 Gbps, Cat6 only reaches 10 Gbps to about 55 meters, and RG-6 is coaxial cable for video/broadband — not twisted-pair Ethernet.',
  },
  {
    id: 'a1-hypervisor', exam: 'A+ Core 1', topic: 'Virtualization',
    question: 'A technician must run several isolated operating systems on one server with direct hardware access and minimal overhead. Which hypervisor type fits?',
    choices: ['Type 1 hypervisor', 'Type 2 hypervisor', 'Container runtime only', 'Hardware emulator'],
    correct_index: 0,
    explanation: 'A Type 1 (bare-metal) hypervisor runs directly on the hardware, giving each VM near-native performance. Type 2 runs on top of a host OS with more overhead, containers share one kernel (no separate OSes), and emulation mimics different hardware rather than virtualizing efficiently.',
  },
  // ---------------- A+ Core 2 (220-1202) ----------------
  {
    id: 'a2-ransomware', exam: 'A+ Core 2', topic: 'Malware types',
    question: 'A user reports their files were renamed with strange extensions and a note demands payment for a decryption key. What type of malware is this?',
    choices: ['Trojan', 'Worm', 'Ransomware', 'Keylogger'],
    correct_index: 2,
    explanation: 'Encrypting files and demanding payment is textbook ransomware. A trojan disguises itself as legitimate software, a worm self-propagates across networks, and a keylogger silently records keystrokes — none demand ransom for encrypted files.',
  },
  {
    id: 'a2-sfc', exam: 'A+ Core 2', topic: 'Windows troubleshooting tools',
    question: 'Windows system files are suspected to be corrupt. Which tool verifies and repairs protected system files?',
    choices: ['chkdsk', 'sfc', 'diskpart', 'format'],
    correct_index: 1,
    explanation: 'sfc /scannow scans and repairs protected Windows system files. chkdsk fixes logical disk errors, diskpart manages partitions, and format wipes the drive — none of them repair system files.',
  },
  {
    id: 'a2-chmod755', exam: 'A+ Core 2', topic: 'Linux permissions',
    question: 'Which chmod value gives the owner full access while group and others get read and execute only?',
    choices: ['777', '755', '644', '700'],
    correct_index: 1,
    explanation: '755 = rwx for owner (7), r-x for group (5), r-x for others (5). 777 gives everyone full access, 644 gives rw/r/r with no execute, and 700 locks everyone but the owner out entirely.',
  },
  {
    id: 'a2-safemode', exam: 'A+ Core 2', topic: 'Windows boot options',
    question: 'Windows fails to boot after a driver update. Which option loads a minimal set of drivers so the bad driver can be removed?',
    choices: ['Safe Mode', 'Normal startup', 'Clean install', 'System reset'],
    correct_index: 0,
    explanation: 'Safe Mode loads only essential drivers, letting you uninstall the bad one. Normal startup reproduces the crash, and a clean install or reset destroys the user\'s data and apps — far too drastic for a driver problem.',
  },
  {
    id: 'a2-vishing', exam: 'A+ Core 2', topic: 'Social engineering',
    question: 'An attacker calls the help desk pretending to be an executive to get a password reset. This attack is best described as:',
    choices: ['Phishing', 'Vishing', 'Whaling', 'Tailgating'],
    correct_index: 1,
    explanation: 'Vishing is phishing done by voice call. Phishing is the email-based version, whaling targets high-profile victims (usually still by email), and tailgating is physically following someone through a secured door.',
  },
  {
    id: 'a2-gpt', exam: 'A+ Core 2', topic: 'Disk partition styles',
    question: 'A 4 TB data drive must use a single partition. Which partition style is required?',
    choices: ['MBR', 'GPT', 'exFAT', 'NTFS'],
    correct_index: 1,
    explanation: 'GPT supports drives well beyond 2 TB, while MBR caps at 2 TB and cannot address a 4 TB single partition. exFAT and NTFS are filesystems, not partition styles — they sit on top of whichever style you choose.',
  },
  {
    id: 'a2-inherence', exam: 'A+ Core 2', topic: 'Authentication factors',
    question: 'Which of the following is an example of the "something you are" authentication factor?',
    choices: ['A password', 'A smart card', 'A fingerprint scan', 'A PIN'],
    correct_index: 2,
    explanation: 'A fingerprint is inherence — something you are. Passwords and PINs are knowledge factors (something you know), and a smart card is a possession factor (something you have).',
  },
  {
    id: 'a2-flushdns', exam: 'A+ Core 2', topic: 'Command-line tools',
    question: 'A user can reach internal sites by IP address but not by name. Which command should be tried FIRST?',
    choices: ['ipconfig /release', 'ipconfig /flushdns', 'netstat -an', 'tracert internal.site'],
    correct_index: 1,
    explanation: 'Name resolution works but returns stale/wrong data, so flushing the DNS resolver cache is the first step. /release drops the DHCP lease (a different problem), netstat only lists connections, and tracert traces the route — useful after DNS is confirmed working.',
  },
  {
    id: 'a2-bitlocker', exam: 'A+ Core 2', topic: 'Disk encryption',
    question: 'An organization wants full-disk encryption on Windows laptops so a stolen drive is unreadable. Which solution fits?',
    choices: ['EFS', 'BitLocker', 'NTFS permissions', 'CHKDSK'],
    correct_index: 1,
    explanation: 'BitLocker encrypts the entire volume, so pulling the drive gets an attacker nothing. EFS encrypts individual files only, NTFS permissions are bypassed the moment the drive is mounted elsewhere, and CHKDSK is a disk-repair tool, not encryption.',
  },
  // ---------------- Security+ (SY0-701) ----------------
  {
    id: 'splus-integrity', exam: 'Security+', topic: 'CIA triad',
    question: 'An attacker intercepts traffic between a client and server and alters the data in transit. Which pillar of the CIA triad is violated?',
    choices: ['Confidentiality', 'Integrity', 'Availability', 'Non-repudiation'],
    correct_index: 1,
    explanation: 'Altering data violates integrity — the data is no longer trustworthy. Merely reading it would violate confidentiality, blocking access would hit availability, and non-repudiation isn\'t part of the triad at all.',
  },
  {
    id: 'splus-zerotrust', exam: 'Security+', topic: 'Zero Trust',
    question: 'Which statement best describes a Zero Trust architecture?',
    choices: [
      'Everything inside the corporate firewall is trusted',
      'Never trust, always verify — every request is authenticated',
      'All remote users must connect through a VPN',
      'Critical systems are physically air-gapped',
    ],
    correct_index: 1,
    explanation: 'Zero Trust assumes breach and verifies every request regardless of where it originates. Trusting the LAN is the old perimeter model Zero Trust replaces, while VPNs and air gaps are individual controls — not the architecture itself.',
  },
  {
    id: 'splus-asymmetric', exam: 'Security+', topic: 'Cryptography',
    question: 'Two parties need to exchange a secret key over an insecure channel with no prior shared secret. Which algorithm type fits?',
    choices: ['AES', 'RSA', 'SHA-256', 'HMAC'],
    correct_index: 1,
    explanation: 'RSA is asymmetric: the public key can travel openly while only the private-key holder reads the message — exactly what key exchange needs. AES is symmetric and requires the key up front, SHA-256 is a one-way hash, and HMAC is a message authentication code — none of them encrypt.',
  },
  {
    id: 'splus-ir-contain', exam: 'Security+', topic: 'Incident response',
    question: 'During incident response, which phase comes immediately AFTER detection and analysis?',
    choices: ['Preparation', 'Containment', 'Eradication', 'Lessons learned'],
    correct_index: 1,
    explanation: 'The order is preparation → detection and analysis → containment → eradication → recovery → lessons learned. You contain first to stop the bleeding; eradication removes the cause, and lessons learned comes last.',
  },
  {
    id: 'splus-tailgating', exam: 'Security+', topic: 'Social engineering',
    question: 'An unauthorized person follows an employee through a badge-controlled door without badging in. This is an example of:',
    choices: ['Phishing', 'Tailgating', 'Shoulder surfing', 'Dumpster diving'],
    correct_index: 1,
    explanation: 'Following someone through access control is tailgating (or piggybacking). Shoulder surfing is watching screens over someone\'s shoulder, dumpster diving is digging through trash for information, and phishing is email-based deception.',
  },
  {
    id: 'splus-salted-hash', exam: 'Security+', topic: 'Password storage',
    question: 'Why are passwords stored as salted hashes instead of plaintext?',
    choices: [
      'It makes logins noticeably faster',
      'It lets administrators read user passwords',
      'A database breach does not reveal usable passwords',
      'It uses less database storage',
    ],
    correct_index: 2,
    explanation: 'Salted hashes mean a stolen database yields no usable passwords and resists rainbow-table attacks. Hashing is slightly slower than plaintext comparison (that\'s a feature), admins should never read passwords, and hashes take more space, not less.',
  },
  {
    id: 'splus-stateful', exam: 'Security+', topic: 'Firewalls',
    question: 'A firewall evaluates each packet in the context of the connection state and prior packets. What type of firewall is it?',
    choices: ['Stateless packet filter', 'Stateful firewall', 'Air gap', 'Honeypot'],
    correct_index: 1,
    explanation: 'Tracking connection state is the definition of a stateful firewall. A stateless filter judges each packet in isolation, an air gap is physical separation (not a firewall), and a honeypot is a decoy system for attracting attackers.',
  },
  {
    id: 'splus-csr', exam: 'Security+', topic: 'PKI and certificates',
    question: 'What is the role of a CSR when obtaining a TLS certificate?',
    choices: [
      'It is the certificate itself',
      'It requests signing from a CA and includes the public key',
      'It revokes a compromised certificate',
      'It encrypts traffic between client and server',
    ],
    correct_index: 1,
    explanation: 'A Certificate Signing Request is sent to the CA containing your public key and identity details; the CA returns the signed certificate. Revocation uses CRLs or OCSP, and encryption is done by TLS itself once the certificate is installed.',
  },
  {
    id: 'splus-soar', exam: 'Security+', topic: 'SIEM vs SOAR',
    question: 'A team wants automated playbooks that isolate a host the moment a critical alert fires. Which solution fits best?',
    choices: ['SIEM', 'SOAR', 'IDS', 'DLP'],
    correct_index: 1,
    explanation: 'SOAR (Security Orchestration, Automation, and Response) runs automated playbooks. A SIEM aggregates and correlates logs but doesn\'t act on its own, an IDS only detects, and DLP focuses on preventing data exfiltration.',
  },
  // ---------------- CCNA (200-301) ----------------
  {
    id: 'ccna-l3', exam: 'CCNA', topic: 'OSI model',
    question: 'Routers operate primarily at which OSI layer?',
    choices: ['Layer 2 — Data Link', 'Layer 3 — Network', 'Layer 4 — Transport', 'Layer 7 — Application'],
    correct_index: 1,
    explanation: 'Routing forwards packets between networks using IP addresses — Layer 3 (Network). Switches forward frames at Layer 2, TCP/UDP live at Layer 4, and user applications sit at Layer 7.',
  },
  {
    id: 'ccna-subnet26', exam: 'CCNA', topic: 'Subnetting',
    question: 'How many usable host addresses does the network 192.168.1.0/26 provide?',
    choices: ['14', '30', '62', '126'],
    correct_index: 2,
    explanation: '/26 leaves 6 host bits: 2^6 = 64 addresses, minus the network and broadcast addresses = 62 usable. /27 would give 30 and /28 would give 14 — each extra subnet bit halves the hosts.',
  },
  {
    id: 'ccna-trunk', exam: 'CCNA', topic: 'VLANs',
    question: 'A switch port must carry traffic for VLANs 10, 20, and 30 to another switch. How should the port be configured?',
    choices: ['Access port on VLAN 10', 'Trunk port', 'Three separate access ports', 'PortFast only'],
    correct_index: 1,
    explanation: 'A trunk carries multiple VLANs over one link using 802.1Q tags. An access port belongs to exactly one VLAN, three access ports wastes cabling, and PortFast only speeds up spanning-tree convergence — it doesn\'t carry VLANs.',
  },
  {
    id: 'ccna-udp', exam: 'CCNA', topic: 'TCP vs UDP',
    question: 'A VoIP call needs low latency and can tolerate occasional packet loss. Which transport protocol fits best?',
    choices: ['TCP', 'UDP', 'ICMP', 'ARP'],
    correct_index: 1,
    explanation: 'UDP is connectionless with minimal overhead — ideal for real-time voice where a retransmitted late packet is useless. TCP\'s reliability adds delay, ICMP is for diagnostics like ping, and ARP only resolves IPs to MAC addresses on the LAN.',
  },
  {
    id: 'ccna-default-route', exam: 'CCNA', topic: 'Static routing',
    question: 'Which command correctly sets a default route on a Cisco router via next-hop 192.168.1.1?',
    choices: [
      'ip route 0.0.0.0 0.0.0.0 192.168.1.1',
      'ip route 192.168.1.0 255.255.255.0 192.168.1.1',
      'router ospf 1',
      'ip default-gateway 192.168.1.1',
    ],
    correct_index: 0,
    explanation: '0.0.0.0 0.0.0.0 matches every destination — the definition of a default route. The second command is a static route to one specific subnet, "router ospf 1" starts dynamic routing, and ip default-gateway is for Layer 2 switches, not routers.',
  },
  {
    id: 'ccna-dora', exam: 'CCNA', topic: 'DHCP',
    question: 'In the DHCP DORA process, which message does the client broadcast FIRST?',
    choices: ['Offer', 'Discover', 'Request', 'Acknowledge'],
    correct_index: 1,
    explanation: 'DORA stands for Discover, Offer, Request, Acknowledge — the client starts by broadcasting a Discover to find servers. The server answers with an Offer, the client sends a Request, and the server finalizes with an Acknowledge.',
  },
  {
    id: 'ccna-inside-local', exam: 'CCNA', topic: 'NAT',
    question: 'Which NAT term describes the private source address BEFORE translation?',
    choices: ['Inside global', 'Inside local', 'Outside local', 'Outside global'],
    correct_index: 1,
    explanation: 'Inside local is the private address as seen on the internal network before NAT. Inside global is the public address after translation; outside local/global describe the destination side.',
  },
  {
    id: 'ccna-ospf', exam: 'CCNA', topic: 'Routing protocols',
    question: 'OSPF is which type of routing protocol?',
    choices: ['Distance-vector', 'Link-state', 'Path-vector', 'Hybrid proprietary'],
    correct_index: 1,
    explanation: 'OSPF is a link-state protocol: routers share link states and each runs Dijkstra\'s algorithm for the shortest path. RIP is distance-vector, BGP is path-vector, and EIGRP is the classic hybrid (now an open standard).',
  },
  {
    id: 'ccna-stp-root', exam: 'CCNA', topic: 'Spanning Tree',
    question: 'How does STP elect the root bridge?',
    choices: [
      'The switch with the highest MAC address wins',
      'The switch with the lowest bridge ID wins',
      'The switch with the most active ports wins',
      'The election is random among switches',
    ],
    correct_index: 1,
    explanation: 'The lowest bridge ID wins — priority first (default 32768), ties broken by lowest MAC address. Highest MAC is backwards, port count doesn\'t matter, and the election is fully deterministic, never random.',
  },
];

export function seedStudyBank(db) {
  let count = 0;
  try {
    count = Number(db.countStudyQuestions() || 0);
  } catch {
    return { seeded: false, reason: 'study_questions table unavailable' };
  }
  if (count > 0) return { seeded: false, reason: 'bank already populated', count };
  let inserted = 0;
  for (const q of STUDY_QUESTIONS) {
    try {
      db.addStudyQuestion({
        id: q.id,
        exam: q.exam,
        topic: q.topic,
        question: q.question,
        choices: q.choices,
        correctIndex: q.correct_index,
        explanation: q.explanation,
        source: 'seed',
      });
      inserted += 1;
    } catch { /* keep going: one bad row must not block the bank */ }
  }
  return { seeded: true, inserted, total: STUDY_QUESTIONS.length };
}
