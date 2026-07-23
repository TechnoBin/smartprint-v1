Create index.js :
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { print } = require("pdf-to-printer");

// ======================
// ENV VALIDATION
// ======================

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "PRINTER_NAME",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

// ======================
// SUPABASE
// ======================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PRINTER_NAME = process.env.PRINTER_NAME;

let isProcessing = false;

// ======================
// FETCH PENDING JOBS
// ======================

async function fetchJobs() {
  const { data, error } = await supabase
    .from("print_jobs")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Supabase fetch error:", error.message);
    return [];
  }

  return data || [];
}

// ======================
// DOWNLOAD PDF
// ======================

async function downloadPDF(url, filePath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 30000,
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);

    response.data.pipe(writer);

    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// ======================
// PRINT FILE
// ======================

async function printFile(filePath, printType) {
  const options = {
    printer: PRINTER_NAME,
    monochrome: String(printType).toLowerCase() === "bw",
  };

  await print(filePath, options);
}

// ======================
// SAFE FILE DELETE
// ======================

function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error("File delete error:", err.message);
  }
}

// ======================
// PROCESS JOBS
// ======================

async function processJobs() {
  if (isProcessing) return;

  isProcessing = true;

  try {
    const jobs = await fetchJobs();

    if (jobs.length === 0) {
      return;
    }

    console.log(`Found ${jobs.length} pending job(s)`);

    for (const job of jobs) {
      const filePath = path.join(__dirname, `temp_${job.id}.pdf`);

      try {
        console.log(`Processing Job: ${job.id}`);

        if (!job.file_url) {
          throw new Error("Missing file_url");
        }

        // Mark as printing
        await supabase
          .from("print_jobs")
          .update({
            status: "printing",
          })
          .eq("id", job.id);

        await downloadPDF(job.file_url, filePath);

        console.log(
          `Downloaded: ${job.file_name || job.id}`
        );

        await printFile(filePath, job.print_type);

        console.log(
          `Printed: ${job.file_name || job.id}`
        );

        const { error } = await supabase
          .from("print_jobs")
          .update({
            status: "printed",
            printed_at: new Date().toISOString(),
            error_message: null,
          })
          .eq("id", job.id);

        if (error) {
          console.error(
            "Status update error:",
            error.message
          );
        }

        deleteFile(filePath);

        console.log(`Completed Job: ${job.id}`);
      } catch (err) {
        console.error(
          `Job Failed (${job.id}):`,
          err.message
        );

        await supabase
          .from("print_jobs")
          .update({
            status: "failed",
            error_message: err.message,
          })
          .eq("id", job.id);

        deleteFile(filePath);
      }
    }
  } catch (err) {
    console.error("Process Error:", err.message);
  } finally {
    isProcessing = false;
  }
}

// ======================
// STARTUP
// ======================

console.log("================================");
console.log(" SmartPrint Print Agent Started ");
console.log(" Printer:", PRINTER_NAME);
console.log("================================");

processJobs();

setInterval(processJobs, 5000);