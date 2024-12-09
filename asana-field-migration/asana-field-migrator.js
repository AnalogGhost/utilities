import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import 'dotenv/config';

// ---------------------------------------
// CONFIGURATION
// ---------------------------------------
const PERSONAL_ACCESS_TOKEN = process.env.ASANA_TOKEN;
const ASANA_PROJECT_GID = process.env.ASANA_PROJECT_GID;
const OLD_FIELD_GID = process.env.OLD_FIELD_GID;
const NEW_FIELD_GID = process.env.NEW_FIELD_GID;
const CSV_MAPPING_FILE = process.env.CSV_MAPPING_FILE;

// ---------------------------------------
// LOAD CSV MAPPING (old_value -> new_value)
// ---------------------------------------
async function loadMapping(csvFile) {
    const fileContent = await readFile(csvFile, 'utf8');
    const records = parse(fileContent, { columns: true, trim: true });
    const mapping = {};
    for (const row of records) {
      mapping[row.old_value] = row.new_value;
    }
    return mapping;
  }

// ---------------------------------------
// FUNCTION TO GET ALL TASKS IN A PROJECT WITH PAGINATION, LIMIT, AND LOGGING
// ---------------------------------------
async function getAllProjectTasks(projectGid) {
    let tasks = [];
    const baseURL = 'https://app.asana.com/api/1.0/tasks';
    
    let url = `${baseURL}?project=${projectGid}&opt_fields=name,custom_fields&limit=100`;
  
    console.log(`Starting to fetch tasks for project: ${projectGid}`);
    
    let pageCount = 0;
  
    while (url) {
      const response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${PERSONAL_ACCESS_TOKEN}`
        }
      });
      
      if (!response.ok) {
        const text = await response.text();
        console.error(`Error fetching tasks: ${text}`);
        throw new Error(`Failed to fetch tasks: ${text}`);
      }
  
      const data = await response.json();
      pageCount++;
      console.log(`Received page ${pageCount} with ${data.data.length} tasks`);
  
      tasks = tasks.concat(data.data);
  
      if (data.next_page && data.next_page.offset) {
        const offset = data.next_page.offset;
        url = `${baseURL}?project=${projectGid}&opt_fields=name,custom_fields&limit=100&offset=${offset}`;
        console.log(`More tasks to fetch, preparing next request`);
      } else {
        console.log('No more pages. Finished fetching all tasks.');
        url = null;
      }
    }
  
    console.log(`Total tasks fetched: ${tasks.length}`);
  
    // Additional checks:
    console.log(`Checking tasks for OLD_FIELD_GID: ${OLD_FIELD_GID} and NEW_FIELD_GID: ${NEW_FIELD_GID}`);
  
    let oldFieldFoundCount = 0;
    let oldFieldWithValueCount = 0;
  
    for (const task of tasks) {
      const { gid: taskGid, name: taskName, custom_fields } = task;
      if (custom_fields && custom_fields.length > 0) {
        // Check if OLD_FIELD_GID is present
        const oldField = custom_fields.find(f => f.gid === OLD_FIELD_GID);
        if (oldField) {
          oldFieldFoundCount++;
          // Check if it has a value set
          if (oldField.enum_value && oldField.enum_value.gid) {
            console.log(`Task "${taskName}" (${taskGid}) has OLD_FIELD_GID field with value: ${oldField.enum_value.gid}`);
            oldFieldWithValueCount++;
          } else {
            console.log(`Task "${taskName}" (${taskGid}) has OLD_FIELD_GID field but no value set.`);
          }
        }
      }
    }
  
    console.log(`Tasks that have the OLD_FIELD_GID (${OLD_FIELD_GID}) present: ${oldFieldFoundCount}`);
    console.log(`Tasks that have the OLD_FIELD_GID set with a value: ${oldFieldWithValueCount}`);
  
    if (oldFieldWithValueCount === 0) {
      console.warn(`No tasks have the OLD_FIELD_GID set with a value. Updates will not occur.`);
    } else {
      console.log(`Some tasks have OLD_FIELD_GID set. You can proceed with the mapping and update logic.`);
    }
  
    return tasks;
}

// ---------------------------------------
// FUNCTION TO UPDATE A TASK
// ---------------------------------------
async function updateTaskCustomField(taskGid, newValue) {
    const body = {
      data: {
        custom_fields: {
          [NEW_FIELD_GID]: newValue
        }
      }
    };
  
    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}`, {
      method: 'PUT',
      headers: {
        "Authorization": `Bearer ${PERSONAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  
    if (!response.ok) {
      const text = await response.text();
      console.error(`Failed to update task ${taskGid}: ${text}`);
    } else {
      console.log(`Successfully updated task ${taskGid} to ${newValue}`);
    }
  }

// ---------------------------------------
// MAIN LOGIC
// ---------------------------------------
(async function main() {
    try {
      const mapping = await loadMapping(CSV_MAPPING_FILE);
      console.log("Mapping loaded:", mapping);
  
      const tasks = await getAllProjectTasks(ASANA_PROJECT_GID);
      console.log(`Fetched ${tasks.length} tasks in total.`);
  
      let tasksAttempted = 0;
      let tasksUpdated = 0;
  
      for (const task of tasks) {
        const { gid: taskGid, custom_fields: customFields, name: taskName } = task;

        // Log the task name and GID for context
        console.log(`Processing task: ${task.name} (GID: ${taskGid})`);
  
        if (!customFields || customFields.length === 0) {
          console.log(`  No custom fields on this task. Skipping.`);
          continue;
        }
  
        let oldEnumGid = null;
  
        // Find the old field
        for (const field of customFields) {
          
            if (field.gid === OLD_FIELD_GID) {
              console.log("  Found the OLD_FIELD_GID on this task.");
              if (field.enum_value && field.enum_value.gid) {
                oldEnumGid = field.enum_value.gid;
                console.log(`  Old field enum GID is ${oldEnumGid}`);
              } else {
                console.log(`  Old field is present but enum_value is missing or null. Skipping.`);
              }
              break;
            }
          }
  
        if (!oldEnumGid) {
          console.log(`  Task has old field but no old value or no old field value. Skipping.`);
          continue;
        }
  
        // We have an oldEnumGid, check if it’s in our mapping
        console.log(`  Old enum GID: ${oldEnumGid}, Checking mapping...`);
  
        if (mapping[oldEnumGid]) {
          const newEnumGid = mapping[oldEnumGid];
          console.log(`  Mapping found. Old enum GID ${oldEnumGid} -> New enum GID ${newEnumGid}`);
          tasksAttempted++;
  
          // Attempt the update
          const updateSuccess = await updateTaskCustomField(taskGid, newEnumGid);
          if (updateSuccess) {
            tasksUpdated++;
            console.log(`  Successfully updated task ${taskGid}.`);
          } else {
            console.log(`  Failed to update task ${taskGid}. Check error logs above.`);
          }
          
          // Wait briefly to respect rate limits
          await new Promise(res => setTimeout(res, 200));
  
        } else {
          console.log(`  No mapping found for old enum GID ${oldEnumGid}. Skipping task.`);
        }
      }
  
      console.log(`Done processing all tasks. Attempted updates: ${tasksAttempted}, Successful updates: ${tasksUpdated}`);
    } catch (err) {
      console.error("Error:", err);
    }
  })();