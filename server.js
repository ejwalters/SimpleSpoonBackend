// server.js (Express API for OpenAI integration)

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import fs from 'fs';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});  

app.post('/ask-ai-chef', async (req, res) => {
    console.log('Received request:', req.body)
  
    const { question, recipe } = req.body;
  
    if (!question || !recipe) {
      return res.status(400).json({ error: 'Question and recipe are required.' });
    }
  
    // Construct a detailed prompt with recipe context
    const systemPrompt = `
  You are a helpful cooking assistant. Use the full recipe context below to answer user questions about substitutions, modifications, or cooking methods.
  Be clear, concise, and friendly. When suggesting a change, explain how it affects the rest of the recipe.
  
  Recipe Title: ${recipe.title}
  Category: ${recipe.tag}
  
  Ingredients:
  ${recipe.ingredients.map((ing) => `• ${ing}`).join('\n')}
  
  Instructions:
  ${recipe.instructions.map((step, i) => `${i + 1}. ${step}`).join('\n')}
    `;
  
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        temperature: 0.7
      });
  
      const answer = response.choices[0].message.content.trim();
      console.log('AI response:', answer);
      res.json({ answer });
    } catch (err) {
      console.error('OpenAI error:', err);
      res.status(500).json({ error: 'Failed to fetch response from AI.' });
    }
});

app.get('/api/recipes', async (req, res) => {
  const { user_id, search, tag } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  let query = supabase
    .from('recipes')
    .select('*')
    .eq('user_id', user_id);

  // Text search (case-insensitive, partial match)
  if (search) {
    query = query.ilike('title', `%${search}%`);
  }

  // Tag filter (supports single or multiple tags)
  if (tag) {
    // If tag is a comma-separated string, split into array
    const tags = Array.isArray(tag) ? tag : tag.split(',');
    // Use Postgres array overlap operator
    query = query.overlaps('tag', tags);
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ recipes: data });
});

app.post('/favorite-recipe', async (req, res) => {
  const { user_id, recipe_id } = req.body;
  console.log('Received favorite recipe:', req.body);

  if (!user_id || !recipe_id) {
    return res.status(400).json({ error: 'Missing user_id or recipe_id.' });
  }

  try {
    const { data, error } = await supabase
      .from('favorites')
      .insert([{ user_id, recipe_id }]);

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('Favorite recipe error:', err);
    res.status(500).json({ error: 'Failed to favorite recipe.' });
  }
});

app.delete('/favorite-recipe', async (req, res) => {
  const { user_id, recipe_id } = req.body;

  if (!user_id || !recipe_id) {
    return res.status(400).json({ error: 'Missing user_id or recipe_id.' });
  }

  try {
    const { data, error } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', user_id)
      .eq('recipe_id', recipe_id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Unfavorite recipe error:', err);
    res.status(500).json({ error: 'Failed to unfavorite recipe.' });
  }
});

app.post('/favorite-recipe-check', async (req, res) => {
  const { user_id, recipe_id } = req.body;
  console.log('Received favorite check:', req.body);

  if (!user_id || !recipe_id) {
    return res.status(400).json({ error: 'Missing user_id or recipe_id.' });
  }

  try {
    const { data, error } = await supabase
      .from('favorites')
      .select('id')
      .eq('user_id', user_id)
      .eq('recipe_id', recipe_id)
      .maybeSingle();

    if (error) throw error;

    res.json({ isFavorited: !!data });
  } catch (err) {
    console.error('Favorite check error:', err);
    res.status(500).json({ error: 'Failed to check favorite status.' });
  }
});

// Helper function to upload image to Supabase Storage
const uploadImageToStorage = async (base64Image, userId, recipeId, imageType) => {
  try {
    // Remove the data URL prefix if present
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    // Generate a unique filename
    const timestamp = Date.now();
    const filename = `${userId}/${recipeId}/${imageType}_${timestamp}.jpg`;

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from('recipe-images')
      .upload(filename, base64Data, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (error) throw error;

    // Get the public URL
    const { data: { publicUrl } } = supabase.storage
      .from('recipe-images')
      .getPublicUrl(filename);

    return publicUrl;
  } catch (err) {
    console.error('Image upload error:', err);
    throw err;
  }
};

app.post('/save-recipe', async (req, res) => {
  const { recipe } = req.body;
  console.log('Received recipe:', recipe);

  if (!recipe || !recipe.title) {
    return res.status(400).json({ error: 'Invalid recipe.' });
  }

  try {
    // Insert the recipe as-is (it should already have image and supporting_images fields)
    const { data, error } = await supabase
      .from('recipes')
      .insert([recipe])
      .select();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('Save recipe error:', err);
    res.status(500).json({ error: 'Failed to save recipe.' });
  }
});

app.post('/inspire-recipes', async (req, res) => {
    const { prompt } = req.body;
  
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }
  
    const systemPrompt = `
    You are an AI sous-chef. Given a prompt from a home cook, return 3 diverse and fun recipe ideas in JSON format. Each recipe must include:
    - "title" (string): the name of the recipe
    - "highlight" (string): 1-sentence teaser
    - "tag" (array of strings): categories like "Dinner", "Vegan", "Snack", "Breakfast"
    - "ingredients" (array of strings): list of ingredients
    - "instructions" (array of strings): step-by-step instructions
    - "nutrition_info" (Return the nutrition_info as a single flat JSON object (not an array or list)): nutrition information for the recipe
    
    Respond ONLY with a JSON array of 3 objects, like this:
    
    [
      {
        "title": "Avocado Toast Deluxe",
        "highlight": "A savory toast with creamy avocado, chili flakes, and lime.",
        "tag": ["Breakfast", "Snack"],
        "ingredients": ["2 slices bread", "1 avocado", "1/2 lime", "Salt", "Chili flakes"],
        "instructions": [
          "Toast the bread.",
          "Mash the avocado with lime and salt.",
          "Spread on toast and sprinkle chili flakes."
        ],
        "nutrition_info":
          {
            "calories": 200,
            "fat": 5,
            "cholesterol": 30,
            "sodium": 10,
            "carbs": 2,
            "fiber": 1,
            "sugar": 100,
            "protein": 5
          }
      }
    ]
    
    User prompt: ${prompt}
    `;
  
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8
      });
  
      const rawText = response.choices[0].message.content.trim();
  
      let recipes;
      try {
        recipes = JSON.parse(rawText);
      } catch (err) {
        console.error('JSON parse error:', err);
        return res.status(500).json({ error: 'Failed to parse AI response.' });
      }
  
      res.json({ recipes });
    } catch (err) {
      console.error('OpenAI error:', err);
      res.status(500).json({ error: 'Failed to generate recipe inspiration.' });
    }
  });
  
app.get('/api/favorite-recipes', async (req, res) => {
  const { user_id, search, tag } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  let query = supabase
    .from('favorites')
    .select(`
      recipe_id,
      recipes (
        id,
        title,
        tag,
        ingredients,
        instructions,
        nutrition_info,
        user_id,
        highlight,
        image,
        supporting_images,
        created_at
      )
    `)
    .eq('user_id', user_id);

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Transform the data to flatten the nested structure
  const favoriteRecipes = data.map(fav => fav.recipes);

  // Apply search filter if provided
  let filteredRecipes = favoriteRecipes;
  if (search) {
    filteredRecipes = favoriteRecipes.filter(recipe => 
      recipe.title.toLowerCase().includes(search.toLowerCase())
    );
  }

  // Apply tag filter if provided
  if (tag) {
    const tags = Array.isArray(tag) ? tag : tag.split(',');
    filteredRecipes = filteredRecipes.filter(recipe => 
      tags.some(t => recipe.tag.includes(t))
    );
  }

  res.json({ recipes: filteredRecipes });
});

app.patch('/update-recipe', async (req, res) => {
  const { id, ...fieldsToUpdate } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Recipe id is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('recipes')
      .update(fieldsToUpdate)
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('Update recipe error:', err);
    res.status(500).json({ error: 'Failed to update recipe.' });
  }
});

app.post('/analyze-recipe-image', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;

    // 1. Use OpenAI Vision (GPT-4o or GPT-4 with vision) to analyze the image
    const imageData = fs.readFileSync(filePath, { encoding: 'base64' });

    const prompt = `You are a recipe extraction assistant. You will be given a photo of a physical recipe, handwritten card, or prepared food. Your task is to extract structured information from the image and infer any missing details using context and general cooking knowledge.

Return a JSON object with the following fields:
- title (string): A clear, concise recipe title. Infer if not explicitly stated.
- highlight (string): A short description of what makes the recipe special or unique.
- ingredients (array of strings): List of ingredients. Infer any that are implied but not explicitly listed.
- instructions (array of strings): Step-by-step instructions. Reconstruct plausible steps if missing.
- nutrition_info (object): Always provide estimated nutritional values for a standard serving, even if the recipe doesn't list them. Use general knowledge or typical values for similar recipes. Include the following keys, and provide a value for each (as a string with units where appropriate):
  - "calories": 200,
  - "fat": 10,
  - "cholesterol": 30,
  - "sodium": 20,
  - "carbs": 20,
  - "fiber": 20,
  - "sugar": 5,
  - "protein": 10

Always return all fields. Do not leave any field blank, null, or empty — infer the best possible estimate when necessary. Return only the JSON object.
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: prompt,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the recipe details from this image.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageData}` } },
          ],
        },
      ],
      max_tokens: 800,
    });

    // Parse the JSON from the model's response
    let extracted = {};
    try {
      const text = response.choices[0].message.content;
      extracted = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse AI response.' });
    }

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    res.json(extracted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to analyze image.' });
  }
});

app.post('/delete-recipe', async (req, res) => {
  const { id } = req.body; // recipe id
  console.log('Deleting recipe:', id);

  if (!id) {
    return res.status(400).json({ error: 'Recipe id is required.' });
  }

  

  try {
    // 1. Delete from favorites
    const { error: favError } = await supabase
      .from('favorites')
      .delete()
      .eq('recipe_id', id);

    if (favError) throw favError;

    // 2. Delete from recipes
    const { data, error } = await supabase
      .from('recipes')
      .delete()
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('Delete recipe error:', err);
    res.status(500).json({ error: 'Failed to delete recipe.' });
  }
});

app.listen(port, () => {
  console.log(`AI Chef backend running on http://localhost:${port}`);
});
