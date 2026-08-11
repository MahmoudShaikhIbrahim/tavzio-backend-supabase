const asyncHandler = require('../utils/asyncHandler');

const listGuests = asyncHandler(async (req, res) => {
  let query = req.supabase.from('hotel_guests').select('*').eq('business_id', req.params.businessId).order('name');
  if (req.query.search) query = query.ilike('name', `%${req.query.search}%`);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createGuest = asyncHandler(async (req, res) => {
  const { name, email = '', phone = '', idDocumentType = '', idDocumentNumber = '', nationality = '', notes = '' } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await req.supabase
    .from('hotel_guests')
    .insert({
      business_id: req.params.businessId, name, email, phone,
      id_document_type: idDocumentType, id_document_number: idDocumentNumber, nationality, notes,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateGuest = asyncHandler(async (req, res) => {
  const { name, email, phone, idDocumentType, idDocumentNumber, nationality, notes } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = email;
  if (phone !== undefined) update.phone = phone;
  if (idDocumentType !== undefined) update.id_document_type = idDocumentType;
  if (idDocumentNumber !== undefined) update.id_document_number = idDocumentNumber;
  if (nationality !== undefined) update.nationality = nationality;
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await req.supabase
    .from('hotel_guests')
    .update(update)
    .eq('id', req.params.guestId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listGuests, createGuest, updateGuest };
