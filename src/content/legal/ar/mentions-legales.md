# البيانات القانونية

الإصدار {version} — ساري المفعول ابتداءً من {effectiveDate}

<!-- Rendu : valeurs entre accolades tirées de config/legal (src/lib/legal/values.ts), marqueurs if/each décrits dans src/lib/legal/template.ts. Une valeur vide n'est jamais remplacée par un texte inventé : chaque section a sa variante « Renseigné avant l'ouverture du site. ». En production, le serveur refuse de démarrer si une mention obligatoire manque (missingLegalMentions). -->

معلومات تحديد هوية الناشر، ومقدّم خدمة الاستضافة، ومقدّمي خدمات استضافة المعطيات الخاصة بـ{brand}، الموضوعة رهن إشارة العموم طبقًا للمادة 1-1 من القانون رقم 2004-575 المؤرخ في 21 يونيو 2004 من أجل الثقة في الاقتصاد الرقمي (LCEN).

## 1. ناشر الموقع {#editeur}

### 1.1 الهوية {#editeur-1}

<!--if:legalForm=EI-->
{entrepreneurName}، مقاول فردي (EI)، الاسم التجاري {companyName}.
<!--endif-->
<!--if:legalForm!=EI-->
{companyName}، {legalForm}<!--if:shareCapital--> رأسمالها {shareCapital} €<!--endif-->.
<!--endif-->

### 1.2 التقييد {#editeur-2}

<!--if:registry=RNE-->
SIREN {siren}، مقيَّد في السجل الوطني للمقاولات (RNE).
<!--endif-->
<!--if:registry=RCS-->
RCS {rcsCity} {siren}.
<!--endif-->
<!--if:siret-->
SIRET {siret}.
<!--endif-->

### 1.3 العنوان والاتصال {#editeur-3}

- العنوان: {address}
- الهاتف: {phone}
- البريد الإلكتروني: {email}

### 1.4 الضريبة على القيمة المضافة {#editeur-4}

<!--if:vatRegime=franchise-->
الضريبة على القيمة المضافة غير مطبَّقة، المادة 293 B من المدونة العامة للضرائب الفرنسية (CGI).
<!--endif-->
<!--if:vatRegime=assujetti-->
رقم الضريبة على القيمة المضافة داخل الاتحاد الأوروبي: {vatNumber}.
<!--endif-->

## 2. مدير النشر {#directeur}

<!--if:publicationDirector-->
مدير النشر: {publicationDirector}.
<!--endif-->
<!--if:!publicationDirector-->
تُعبَّأ قبل فتح الموقع.
<!--endif-->

## 3. مقدّم خدمة الاستضافة {#hebergeur}

<!--if:hostComplete-->
{hostName}: {hostAddress}، الهاتف {hostPhone}.
<!--endif-->
<!--if:hostPartial-->
{hostName}: بيانات الاتصال تُعبَّأ قبل فتح الموقع.
<!--endif-->
<!--if:hostMissing-->
تُعبَّأ قبل فتح الموقع.
<!--endif-->

## 4. استضافة المعطيات {#donnees}

تُخزَّن المعطيات التي يعالجها الناشر مباشرة (الحسابات، الإعلانات، الرسائل، الصور) لدى مقدّمي الخدمات المذكورين أدناه، ولو بالمجان. وتُحيَّن هذه القائمة عندما يتغيّر مقدّم خدمة. وترد القائمة الكاملة للمعالجين من الباطن، ودورهم، وعمليات نقل المعطيات في [سياسة الخصوصية](/legal/confidentialite).

<!--each:dataHosts-->
<!--if:entry.complete-->
- {entry.label}: {entry.address}، الهاتف {entry.phone}
<!--endif-->
<!--if:entry.partial-->
- {entry.label}: بيانات الاتصال تُعبَّأ قبل فتح الموقع.
<!--endif-->
<!--if:entry.noName-->
- تُعبَّأ قبل فتح الموقع.
<!--endif-->
<!--endeach-->
<!--if:!dataHosts-->
تُعبَّأ قبل فتح الموقع.
<!--endif-->

## 5. جهات الاتصال {#contacts}

- نقطة الاتصال الموحَّدة للسلطات والمستخدمين (اللائحة (UE) 2022/2065، « DSA »): {dsaContactEmail}، اللغات المقبولة: {dsaContactLanguages}. انظروا [الاتصال بالسلطات (DSA)](/legal/contact-autorites).
- الإساءات التقنية (التصيّد الاحتيالي، القرصنة، الثغرة الأمنية): {abuseEmail}.
- المعطيات الشخصية: {dpoContact}.
- الاتصال العام: {email}.
<!--if:consumerMediator.name-->
- وسيط الاستهلاك: {consumerMediator.name} ‏({consumerMediator.url}).
<!--endif-->

<!--if:cndpReceiptNo-->
كانت المعالجات التي تخص الأشخاص الموجودين بالمغرب موضوع تصريح لدى اللجنة الوطنية لمراقبة حماية المعطيات ذات الطابع الشخصي (CNDP)، وصل رقم {cndpReceiptNo}.
<!--endif-->

## 6. دور {brand} {#role}

### 6.1 خدمة لاستضافة الإعلانات {#role-1}

تستضيف {brand} الإعلانات التي ينشرها مستخدموها. وليست بائعًا ولا مشتريًا ولا وكيلًا، وليست طرفًا في العقود المبرمة بين المستخدمين. ولا تستخلص أي أداء بين المستخدمين. والمعلِن مُبيَّن دائمًا ويظل وحده مسؤولًا عن إعلانه وعن المعاملة التي تليه (انظروا [الشروط العامة للاستخدام](/legal/cgu#role)).

### 6.2 المسؤولية {#role-2}

بالنسبة للمحتويات التي يقدّمها المستخدمون، تخضع {brand} لنظام مقدّمي خدمات الاستضافة: فهي لا تمارس مراقبة عامة للمحتويات (المادة 8 من DSA) وتتصرف بسرعة لسحب محتوى غير مشروع علمت به فعليًا. ولا يشمل هذا النظام التزاماتها الخاصة، ولا سيما في مجال المعطيات الشخصية. وتُسأل {brand} عن التزاماتها الخاصة وعن حسن تنفيذ الخيارات التي تبيعها (انظروا [الشروط العامة للاستخدام](/legal/cgu#responsabilite)).

لا شيء في هذه الصفحة يحدّ من مسؤولية {brand} في حالة الخطأ الجسيم أو التدليس أو الضرر الجسدي، ولا من الحقوق التي يمنحها القانون للمستهلك.
