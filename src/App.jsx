import React, { useState, useMemo, useEffect } from 'react';
import { ShoppingBag, Search, ChevronLeft, Menu, SlidersHorizontal, Plus, Minus, ArrowRight, Send, X, Loader2 } from 'lucide-react';
import { supabase } from './lib/supabaseClient';

const CATEGORIES = ['All', 'Skincare', 'Beauty', 'Fragrance'];

// A product is considered "New" for 72 hours after its creation in the CRM.
const NEW_BADGE_WINDOW_MS = 72 * 60 * 60 * 1000;
const isNewProduct = (product) => {
  if (!product?.created_at) return false;
  return Date.now() - new Date(product.created_at).getTime() < NEW_BADGE_WINDOW_MS;
};

// Minimal, Swiss/Apple-style "New" tag: black & white, thin, uppercase, lots of tracking.
// No gradients, no glow, no color — just quiet typographic confidence.
const NewBadge = ({ className = '' }) => (
  <span
    className={`inline-flex items-center bg-white/95 backdrop-blur-sm text-black text-[9px] font-semibold uppercase tracking-[0.2em] px-2.5 py-1 border border-black/10 rounded-full ${className}`}
  >
    New
  </span>
);

// Maps a raw Supabase "products" row (managed from the CRM) to the shape the UI expects.
const mapDbProduct = (row) => ({
  id: row.id,
  category: row.category || 'Skincare',
  type: row.sub_type || row.category || 'Product',
  name: row.name,
  price: Number(row.unit_price ?? row.price ?? 0),
  description: row.description || '',
  ingredients: row.ingredients || '',
  mainImage: row.image_url || 'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?q=80&w=1000&auto=format&fit=crop',
  gallery: [],
  created_at: row.created_at,
});

export default function App() {
  const [currentView, setCurrentView] = useState('home'); // 'home', 'category', 'product', 'cart', 'checkout', 'order-confirmation', 'contact', 'shipping', 'faq', 'terms', 'privacy', 'cookies', 'instagram', 'pinterest'
  const [activeCategory, setActiveCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState('All types');
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Product catalog is now owned by the CRM: it lives in Supabase and simply
  // shows up here as soon as it's added on the "Inventory" tab of the dashboard.
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState(null);

  // Real shopping cart (was a simple counter before).
  const [cart, setCart] = useState([]); // [{ id, name, price, mainImage, qty }]
  const [lastOrder, setLastOrder] = useState(null);
  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [currentView, selectedProduct, activeCategory]);

  const fetchProducts = async () => {
    setProductsLoading(true);
    setProductsError(null);
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error(error);
      setProductsError(error.message);
      setProductsLoading(false);
      return;
    }
    setProducts((data || []).map(mapDbProduct));
    setProductsLoading(false);
  };

  useEffect(() => {
    fetchProducts();

    // Live sync: as soon as a product is added / edited / removed from the CRM,
    // the site refreshes automatically, without needing a page reload.
    const channel = supabase
      .channel('site:products')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        fetchProducts();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const filteredProducts = useMemo(() => {
    return products.filter(product => {
      const matchCategory = activeCategory === 'All' || product.category === activeCategory;
      const matchSearch = product.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          product.description.toLowerCase().includes(searchQuery.toLowerCase());
      const matchType = selectedType === 'All types' || product.type === selectedType;
      return matchCategory && matchSearch && matchType;
    });
  }, [products, activeCategory, searchQuery, selectedType]);

  const availableTypes = useMemo(() => {
    let productsInCat = products;
    if (activeCategory !== 'All') {
      productsInCat = products.filter(p => p.category === activeCategory);
    }
    const types = new Set(productsInCat.map(p => p.type));
    return ['All types', ...Array.from(types)];
  }, [products, activeCategory]);

  // ---------- Cart helpers ----------
  const addToCart = (product, qty = 1) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) {
        return prev.map(i => i.id === product.id ? { ...i, qty: i.qty + qty } : i);
      }
      return [...prev, { id: product.id, name: product.name, price: product.price, mainImage: product.mainImage, qty }];
    });
  };

  const updateCartQty = (id, qty) => {
    setCart(prev => {
      if (qty <= 0) return prev.filter(i => i.id !== id);
      return prev.map(i => i.id === id ? { ...i, qty } : i);
    });
  };

  const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id));

  const cartCount = cart.reduce((sum, i) => sum + i.qty, 0);
  const cartTotal = cart.reduce((sum, i) => sum + i.qty * i.price, 0);

  // Placing an order does three things in one go, directly from the site:
  // 1. creates the contact as a Lead in the CRM
  // 2. creates the sale (transaction) for that lead, with its total
  // 3. attaches every cart line as a transaction_item
  // The order therefore appears in the CRM's "Leads & Clients" tab already
  // attached to its cart — no manual step, no pipeline.
  const submitOrder = async ({ name, email, phone, address }) => {
    setCheckoutSubmitting(true);
    setCheckoutError(null);
    try {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .insert({ name, email, phone, address, type: 'lead' })
        .select()
        .single();
      if (contactError) throw contactError;

      const invoiceNumber = `WEB-${Date.now().toString().slice(-6)}`;
      const { data: tx, error: txError } = await supabase
        .from('transactions')
        .insert({
          type: 'vente',
          contact_id: contact.id,
          total_amount: cartTotal,
          invoice_number: invoiceNumber,
        })
        .select()
        .single();
      if (txError) throw txError;

      const items = cart.map((i) => ({
        transaction_id: tx.id,
        product_id: i.id,
        quantity: i.qty,
        unit_price: i.price,
      }));
      const { error: itemsError } = await supabase.from('transaction_items').insert(items);
      if (itemsError) throw itemsError;

      // Best-effort stock decrement; an order is never blocked by this.
      for (const item of cart) {
        try {
          const { data: prod } = await supabase
            .from('products')
            .select('stock_quantity')
            .eq('id', item.id)
            .maybeSingle();
          if (prod && typeof prod.stock_quantity === 'number') {
            await supabase
              .from('products')
              .update({ stock_quantity: Math.max(0, prod.stock_quantity - item.qty) })
              .eq('id', item.id);
          }
        } catch (stockErr) {
          console.warn('Stock update skipped for product', item.id, stockErr);
        }
      }

      setLastOrder({ invoiceNumber, total: cartTotal, items: cart, name });
      setCart([]);
      setCurrentView('order-confirmation');
    } catch (err) {
      console.error(err);
      setCheckoutError(err.message || 'Something went wrong while placing your order.');
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  const navigateToCategory = (category) => {
    setActiveCategory(category);
    setSelectedType('All types');
    setSearchQuery('');
    setCurrentView('category');
    setSelectedProduct(null);
  };

  const Header = () => (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-zinc-100 transition-all duration-300">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center w-1/3">
          <button className="md:hidden p-2 -ml-2 text-zinc-900">
            <Menu strokeWidth={1.5} size={20} />
          </button>
          <nav className="hidden md:flex space-x-6 text-xs font-medium tracking-wide text-zinc-500 uppercase">
            {CATEGORIES.slice(1).map(cat => (
              <button 
                key={cat}
                onClick={() => navigateToCategory(cat)}
                className={`hover:text-black transition-colors ${activeCategory === cat && currentView === 'category' ? 'text-black' : ''}`}
              >
                {cat}
              </button>
            ))}
          </nav>
        </div>
        
        <div className="w-1/3 flex justify-center">
          <button 
            className="text-xl font-semibold tracking-widest text-black uppercase"
            onClick={() => {
              setCurrentView('home');
              setSelectedProduct(null);
            }}
          >
            Maison Vera
          </button>
        </div>
        
        <div className="w-1/3 flex justify-end items-center space-x-4">
          <button 
            onClick={() => navigateToCategory('All')}
            className="p-2 text-zinc-900 hover:opacity-50 transition-opacity"
          >
            <Search strokeWidth={1.5} size={20} />
          </button>
          <button
            onClick={() => setCurrentView('cart')}
            className="p-2 -mr-2 text-zinc-900 hover:opacity-50 transition-opacity relative"
          >
            <ShoppingBag strokeWidth={1.5} size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center bg-black text-white text-[10px] font-medium rounded-full">
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );

  const HomeView = () => (
    <div className="animate-in fade-in duration-1000">
      <section className="relative h-[90vh] w-full bg-zinc-50 flex items-center justify-center overflow-hidden">
        <img 
          src="https://images.unsplash.com/photo-1615397323294-26d1cedd9e8b?q=80&w=2000&auto=format&fit=crop" 
          alt="Maison Vera Beauty" 
          className="absolute inset-0 w-full h-full object-cover opacity-90 mix-blend-multiply scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-white/40 via-transparent to-transparent"></div>
        <div className="relative z-10 text-center flex flex-col items-center px-4">
          <h1 className="text-6xl md:text-8xl font-semibold tracking-tighter text-black mb-6 max-w-4xl leading-[1.1]">
            The essence of <br/>absolute beauty.
          </h1>
          <p className="text-lg md:text-xl text-zinc-800 font-light max-w-xl mb-10">
            A curated collection of skincare and fragrances engineered with precision, designed to reveal your natural radiance.
          </p>
          <button 
            onClick={() => navigateToCategory('All')}
            className="bg-black text-white px-8 py-4 text-xs uppercase tracking-widest font-medium hover:bg-zinc-800 transition-all flex items-center space-x-2 rounded-full shadow-2xl hover:shadow-xl hover:-translate-y-0.5"
          >
            <span>Discover the collection</span>
          </button>
        </div>
      </section>

      <section className="py-32 px-6 bg-white max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
          <div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-black mb-8 leading-tight">
              The Art of<br/>Simplicity.
            </h2>
            <p className="text-lg leading-relaxed text-zinc-500 font-light mb-6">
              At Maison Vera, we believe that true luxury lies in absolute refinement. 
              Our minimalist formulas combine cutting-edge scientific innovation with the purity 
              of the most noble botanical ingredients. 
            </p>
            <p className="text-lg leading-relaxed text-zinc-500 font-light">
              Fewer artificial additions, more profound efficacy. 
              An uncompromising aesthetic approach for an elevated daily beauty ritual. We source sustainably, formulate consciously, and design with purpose.
            </p>
          </div>
          <div className="aspect-[4/5] bg-zinc-100 rounded-2xl overflow-hidden">
             <img 
              src="https://images.unsplash.com/photo-1620916566398-39f1143ab7be?q=80&w=1000&auto=format&fit=crop" 
              alt="Brand Ethos" 
              className="w-full h-full object-cover mix-blend-multiply"
            />
          </div>
        </div>
      </section>

      <section className="px-6 pb-24 max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-black">Our Worlds</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-[400px]">
          <div 
            onClick={() => navigateToCategory('Skincare')}
            className="relative bg-zinc-100 group cursor-pointer overflow-hidden md:row-span-2 md:h-[816px] flex flex-col justify-end p-10 rounded-2xl"
          >
            <img 
              src="https://images.unsplash.com/photo-1556228578-0d85b1a4d571?q=80&w=1000&auto=format&fit=crop" 
              alt="Skincare" 
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-black/10 group-hover:bg-black/20 transition-colors duration-500"></div>
            <div className="relative z-10 text-white">
              <h3 className="text-3xl font-semibold tracking-tight mb-2">Skincare</h3>
              <p className="font-light text-white/90 mb-6 text-lg">The science of cellular regeneration.</p>
              <span className="inline-flex items-center space-x-2 text-xs uppercase tracking-widest font-medium bg-white/25 backdrop-blur-md px-4 py-2 rounded-full">
                <span>Explore</span> <ArrowRight size={14} />
              </span>
            </div>
          </div>
          
          <div 
            onClick={() => navigateToCategory('Beauty')}
            className="relative bg-zinc-100 group cursor-pointer overflow-hidden p-10 flex flex-col justify-end rounded-2xl"
          >
            <img 
              src="https://images.unsplash.com/photo-1586495777744-4413f21062fa?q=80&w=1000&auto=format&fit=crop" 
              alt="Beauty" 
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-black/10 group-hover:bg-black/20 transition-colors duration-500"></div>
            <div className="relative z-10 text-white">
              <h3 className="text-2xl font-semibold tracking-tight mb-2">Beauty</h3>
              <p className="font-light text-white/90 mb-4">Natural radiance sublimated.</p>
              <span className="inline-flex items-center space-x-2 text-xs uppercase tracking-widest font-medium bg-white/25 backdrop-blur-md px-4 py-2 rounded-full">
                <span>Explore</span> <ArrowRight size={14} />
              </span>
            </div>
          </div>

          <div 
            onClick={() => navigateToCategory('Fragrance')}
            className="relative bg-zinc-100 group cursor-pointer overflow-hidden p-10 flex flex-col justify-end rounded-2xl"
          >
            <img 
              src="https://images.unsplash.com/photo-1594035910387-fea47794261f?q=80&w=1000&auto=format&fit=crop" 
              alt="Fragrance" 
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-black/10 group-hover:bg-black/20 transition-colors duration-500"></div>
            <div className="relative z-10 text-black">
              <h3 className="text-2xl font-semibold tracking-tight mb-2">Fragrance</h3>
              <p className="font-light text-black/80 mb-4">Unforgettable olfactory signatures.</p>
              <span className="inline-flex items-center space-x-2 text-xs uppercase tracking-widest font-medium bg-black/10 backdrop-blur-md px-4 py-2 rounded-full">
                <span>Explore</span> <ArrowRight size={14} />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-24 bg-zinc-50 border-t border-zinc-200">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex justify-between items-end mb-12">
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-black">Latest Arrivals</h2>
            <button 
              onClick={() => navigateToCategory('All')}
              className="hidden md:flex items-center text-xs uppercase tracking-widest font-medium text-zinc-500 hover:text-black transition-colors group"
            >
              View All <ArrowRight size={14} className="ml-2 group-hover:translate-x-1 transition-transform" />
            </button>
          </div>

          {productsLoading ? (
            <div className="py-20 text-center text-zinc-400 font-light text-sm">Loading the collection…</div>
          ) : products.length === 0 ? (
            <div className="py-20 text-center text-zinc-400 font-light text-sm">New pieces are on their way.</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-10">
              {products.slice(0, 4).map((product) => (
                <div 
                  key={`fav-${product.id}`} 
                  className="group cursor-pointer flex flex-col"
                  onClick={() => {
                    setSelectedProduct(product);
                    setCurrentView('product');
                  }}
                >
                  <div className="relative aspect-square overflow-hidden bg-white mb-4 rounded-xl border border-zinc-100">
                    <img 
                      src={product.mainImage} 
                      alt={product.name}
                      className="object-cover w-full h-full transition-transform duration-700 ease-out group-hover:scale-105 mix-blend-multiply"
                      loading="lazy"
                    />
                    {isNewProduct(product) && (
                      <NewBadge className="absolute top-3 left-3" />
                    )}
                  </div>
                  <div className="flex flex-col px-1">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1">{product.category}</p>
                    <h3 className="text-sm text-black font-medium tracking-tight mb-1 truncate">{product.name}</h3>
                    <span className="text-xs text-zinc-500">${product.price}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );

  const CategoryView = () => (
    <div className="animate-in fade-in duration-700 min-h-screen">
      <div className="max-w-7xl mx-auto px-6 py-16">
        <h1 className="text-4xl md:text-6xl font-semibold tracking-tight text-black mb-16 text-center">
          {activeCategory === 'All' ? 'Complete Collection' : activeCategory}
        </h1>

        <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-12 border-b border-zinc-100 pb-8">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" size={16} strokeWidth={2} />
            <input 
              type="text" 
              placeholder="Search a product..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-full py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-black focus:ring-1 focus:ring-black transition-all placeholder:text-zinc-400 text-black"
            />
          </div>
          
          <div className="flex items-center space-x-3 w-full md:w-auto">
            <SlidersHorizontal size={16} className="text-zinc-400" strokeWidth={2} />
            <select 
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="bg-transparent text-sm font-medium focus:outline-none text-zinc-900 cursor-pointer"
            >
              {availableTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
        </div>

        {productsLoading ? (
          <div className="text-center py-32 text-zinc-400 font-light text-lg">Loading the collection…</div>
        ) : filteredProducts.length === 0 ? (
          <div className="text-center py-32 text-zinc-500 font-light text-lg">
            No products match your search.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-x-6 gap-y-12">
            {filteredProducts.map((product) => (
              <div 
                key={product.id} 
                className="group cursor-pointer flex flex-col"
                onClick={() => {
                  setSelectedProduct(product);
                  setCurrentView('product');
                }}
              >
                <div className="relative aspect-square overflow-hidden bg-zinc-50 mb-4 rounded-xl border border-zinc-100">
                  <img 
                    src={product.mainImage} 
                    alt={product.name}
                    className="object-cover w-full h-full transition-transform duration-700 ease-out group-hover:scale-105 mix-blend-multiply"
                    loading="lazy"
                  />
                  {isNewProduct(product) && (
                    <NewBadge className="absolute top-3 left-3" />
                  )}
                </div>
                <div className="flex flex-col px-1">
                  <p className="text-[10px] text-zinc-400 uppercase tracking-widest font-semibold mb-1">{product.type}</p>
                  <h3 className="text-sm text-black font-medium tracking-tight mb-1 truncate">{product.name}</h3>
                  <span className="text-sm text-zinc-600">${product.price}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const ProductDetailView = () => (
    <div className="max-w-7xl mx-auto px-6 py-12 animate-in slide-in-from-bottom-8 fade-in duration-700">
      <button 
        onClick={() => setCurrentView('category')}
        className="flex items-center text-xs uppercase tracking-widest font-medium text-zinc-500 hover:text-black transition-colors mb-12 group"
      >
        <ChevronLeft size={16} strokeWidth={2} className="mr-2 group-hover:-translate-x-1 transition-transform" />
        Back to {activeCategory === 'All' ? 'collection' : activeCategory}
      </button>

      <div className="flex flex-col lg:flex-row gap-16 lg:gap-24">
        <div className="w-full lg:w-1/2 flex flex-col gap-4">
          <div className="relative aspect-[4/5] bg-zinc-50 overflow-hidden rounded-2xl border border-zinc-100">
            <img 
              src={selectedProduct.mainImage} 
              alt={selectedProduct.name}
              className="w-full h-full object-cover mix-blend-multiply"
            />
            {isNewProduct(selectedProduct) && (
              <NewBadge className="absolute top-4 left-4" />
            )}
          </div>
          {selectedProduct.gallery.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              {selectedProduct.gallery.map((img, idx) => (
                <div key={idx} className="aspect-square bg-zinc-50 overflow-hidden rounded-xl border border-zinc-100">
                  <img 
                    src={img} 
                    alt={`${selectedProduct.name} detail ${idx + 1}`}
                    className="w-full h-full object-cover mix-blend-multiply"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="w-full lg:w-1/2">
          <div className="sticky top-32">
            <div className="mb-10">
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-4">
                {selectedProduct.category} · {selectedProduct.type}
              </p>
              <h1 className="text-4xl md:text-5xl text-black font-semibold tracking-tight mb-4">{selectedProduct.name}</h1>
              <p className="text-2xl text-zinc-600 font-medium">${selectedProduct.price}</p>
            </div>

            <div className="mb-12">
              <button 
                onClick={() => {
                  addToCart(selectedProduct);
                  setCurrentView('cart');
                }}
                className="w-full bg-black text-white py-4 text-xs font-medium tracking-widest uppercase hover:bg-zinc-800 transition-all flex items-center justify-center space-x-3 rounded-full shadow-lg hover:shadow-xl hover:-translate-y-0.5"
              >
                <span>Add to Bag</span>
                <Plus size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="space-y-10 border-t border-zinc-100 pt-10">
              <div>
                <h3 className="text-xs font-semibold text-black uppercase tracking-widest mb-4">Description</h3>
                <p className="text-zinc-600 font-light leading-relaxed text-sm md:text-base">
                  {selectedProduct.description}
                </p>
              </div>

              {selectedProduct.ingredients && (
                <div>
                  <h3 className="text-xs font-semibold text-black uppercase tracking-widest mb-4">Key Ingredients</h3>
                  <p className="text-zinc-500 font-light leading-relaxed text-sm">
                    {selectedProduct.ingredients}
                  </p>
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold text-black uppercase tracking-widest mb-4">How to use</h3>
                <p className="text-zinc-500 font-light leading-relaxed text-sm">
                  Apply morning and evening to clean, dry skin. Massage gently until fully absorbed for optimal results.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const CartView = () => (
    <div className="max-w-4xl mx-auto px-6 py-16 animate-in fade-in duration-700 min-h-[60vh]">
      <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-black mb-12">Your Bag</h1>

      {cart.length === 0 ? (
        <div className="text-center py-24">
          <p className="text-zinc-500 font-light mb-8">Your bag is empty.</p>
          <button
            onClick={() => navigateToCategory('All')}
            className="bg-black text-white px-8 py-4 text-xs uppercase tracking-widest font-medium hover:bg-zinc-800 transition-all rounded-full"
          >
            Discover the collection
          </button>
        </div>
      ) : (
        <>
          <div className="divide-y divide-zinc-100 border-t border-b border-zinc-100 mb-10">
            {cart.map((item) => (
              <div key={item.id} className="flex items-center gap-6 py-6">
                <div className="w-24 h-24 bg-zinc-50 rounded-xl overflow-hidden flex-shrink-0 border border-zinc-100">
                  <img src={item.mainImage} alt={item.name} className="w-full h-full object-cover mix-blend-multiply" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-black truncate mb-1">{item.name}</h3>
                  <p className="text-sm text-zinc-500">${item.price}</p>
                </div>
                <div className="flex items-center border border-zinc-200 rounded-full">
                  <button
                    onClick={() => updateCartQty(item.id, item.qty - 1)}
                    className="p-2 text-zinc-500 hover:text-black transition-colors"
                  >
                    <Minus size={14} />
                  </button>
                  <span className="w-6 text-center text-sm">{item.qty}</span>
                  <button
                    onClick={() => updateCartQty(item.id, item.qty + 1)}
                    className="p-2 text-zinc-500 hover:text-black transition-colors"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <span className="w-20 text-right text-sm font-medium text-black">${(item.qty * item.price).toFixed(2)}</span>
                <button onClick={() => removeFromCart(item.id)} className="p-2 text-zinc-300 hover:text-black transition-colors">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between mb-10">
            <span className="text-sm text-zinc-500 uppercase tracking-widest">Total</span>
            <span className="text-2xl font-semibold text-black">${cartTotal.toFixed(2)}</span>
          </div>

          <button
            onClick={() => setCurrentView('checkout')}
            className="w-full bg-black text-white py-4 text-xs font-medium tracking-widest uppercase hover:bg-zinc-800 transition-all rounded-full shadow-lg hover:shadow-xl hover:-translate-y-0.5"
          >
            Proceed to Checkout
          </button>
        </>
      )}
    </div>
  );

  const CheckoutView = () => {
    const [form, setForm] = useState({ name: '', email: '', phone: '', address: '' });

    if (cart.length === 0) {
      return (
        <div className="max-w-2xl mx-auto px-6 py-24 text-center animate-in fade-in duration-700">
          <p className="text-zinc-500 font-light mb-8">Your bag is empty.</p>
          <button
            onClick={() => navigateToCategory('All')}
            className="bg-black text-white px-8 py-4 text-xs uppercase tracking-widest font-medium hover:bg-zinc-800 transition-all rounded-full"
          >
            Discover the collection
          </button>
        </div>
      );
    }

    return (
      <div className="max-w-5xl mx-auto px-6 py-16 animate-in fade-in duration-700">
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-black mb-12">Checkout</h1>
        <div className="flex flex-col lg:flex-row gap-16">
          <form
            onSubmit={(e) => { e.preventDefault(); submitOrder(form); }}
            className="w-full lg:w-3/5 space-y-6"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Full Name</label>
                <input
                  required
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-black"
                  placeholder="Jane Doe"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Email Address</label>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-black"
                  placeholder="jane@example.com"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-black"
                placeholder="+41 00 000 00 00"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Shipping Address</label>
              <textarea
                required
                rows={3}
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-sm focus:outline-none focus:border-black"
                placeholder="Street, city, postal code, country"
              />
            </div>

            {checkoutError && (
              <p className="text-sm text-rose-600">{checkoutError}</p>
            )}

            <button
              type="submit"
              disabled={checkoutSubmitting}
              className="w-full bg-black text-white py-4 text-xs font-medium tracking-widest uppercase hover:bg-zinc-800 transition-all rounded-full shadow-lg hover:shadow-xl hover:-translate-y-0.5 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {checkoutSubmitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> <span>Placing Order…</span>
                </>
              ) : (
                <span>Place Order</span>
              )}
            </button>
          </form>

          <div className="w-full lg:w-2/5">
            <div className="bg-zinc-50 rounded-2xl p-6 sticky top-32">
              <h3 className="text-xs font-semibold text-black uppercase tracking-widest mb-6">Order Summary</h3>
              <div className="space-y-4 mb-6">
                {cart.map((item) => (
                  <div key={item.id} className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-white rounded-lg overflow-hidden flex-shrink-0 border border-zinc-100">
                      <img src={item.mainImage} alt={item.name} className="w-full h-full object-cover mix-blend-multiply" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-black truncate">{item.name}</p>
                      <p className="text-xs text-zinc-500">Qty {item.qty}</p>
                    </div>
                    <span className="text-sm text-zinc-700">${(item.qty * item.price).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-zinc-200 pt-4">
                <span className="text-sm text-zinc-500 uppercase tracking-widest">Total</span>
                <span className="text-xl font-semibold text-black">${cartTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const OrderConfirmationView = () => (
    <div className="max-w-2xl mx-auto px-6 py-28 text-center animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-4">Thank you{lastOrder?.name ? `, ${lastOrder.name.split(' ')[0]}` : ''}.</h1>
      <p className="text-zinc-500 font-light mb-2">Your order has been placed successfully.</p>
      {lastOrder && (
        <p className="text-sm text-zinc-400 mb-10">Order {lastOrder.invoiceNumber} · ${lastOrder.total.toFixed(2)}</p>
      )}
      <button
        onClick={() => { setCurrentView('home'); setLastOrder(null); }}
        className="bg-black text-white px-8 py-4 text-xs uppercase tracking-widest font-medium hover:bg-zinc-800 transition-all rounded-full"
      >
        Back to Home
      </button>
    </div>
  );

  const ContactView = () => {
    const [submitted, setSubmitted] = useState(false);
    return (
      <div className="max-w-3xl mx-auto px-6 py-20 animate-in fade-in duration-700">
        <h1 className="text-4xl font-semibold tracking-tight mb-6">Contact Us</h1>
        <p className="text-zinc-500 font-light mb-12">We are here to assist you with any inquiries regarding our collections or your orders.</p>
        {submitted ? (
          <div className="p-8 bg-zinc-50 rounded-2xl text-center">
            <h3 className="text-lg font-medium mb-2">Message Sent Successfully</h3>
            <p className="text-sm text-zinc-500 font-light mb-6">Thank you for reaching out. Our client service team will get back to you shortly.</p>
            <button onClick={() => setSubmitted(false)} className="text-xs uppercase tracking-widest underline font-medium">Send another message</button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); setSubmitted(true); }} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Full Name</label>
                <input required type="text" className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-black" placeholder="Jane Doe" />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Email Address</label>
                <input required type="email" className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-black" placeholder="jane@example.com" />
              </div>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-widest text-zinc-500 mb-2 font-medium">Message</label>
              <textarea required rows={5} className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-sm focus:outline-none focus:border-black" placeholder="How can we help you?"></textarea>
            </div>
            <button type="submit" className="bg-black text-white px-8 py-4 text-xs uppercase tracking-widest font-medium hover:bg-zinc-800 transition-all rounded-full flex items-center space-x-2">
              <span>Send Message</span>
              <Send size={14} />
            </button>
          </form>
        )}
      </div>
    );
  };

  const ShippingView = () => (
    <div className="max-w-3xl mx-auto px-6 py-20 animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-6">Shipping & Returns</h1>
      <div className="space-y-8 text-zinc-600 font-light leading-relaxed">
        <div>
          <h3 className="text-lg font-medium text-black mb-2">Complimentary Shipping</h3>
          <p>Maison Vera offers complimentary standard shipping on all orders over $100. Deliveries are processed within 24–48 hours from our fulfillment centers.</p>
        </div>
        <div>
          <h3 className="text-lg font-medium text-black mb-2">Delivery Times</h3>
          <p>Standard delivery typically takes 3 to 5 business days. Express shipping options are available at checkout for urgent deliveries.</p>
        </div>
        <div>
          <h3 className="text-lg font-medium text-black mb-2">Returns & Exchanges</h3>
          <p>We accept returns of unopened and unused products within 30 days of purchase. Please contact our support team to initiate a return label.</p>
        </div>
      </div>
    </div>
  );

  const FAQView = () => (
    <div className="max-w-3xl mx-auto px-6 py-20 animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-6">Frequently Asked Questions</h1>
      <div className="space-y-8 text-zinc-600 font-light leading-relaxed">
        <div>
          <h3 className="text-lg font-medium text-black mb-2">Are your formulations suitable for sensitive skin?</h3>
          <p>Yes, all Maison Vera products undergo rigorous dermatological testing and are formulated without harsh irritants, ensuring suitability for sensitive skin types.</p>
        </div>
        <div>
          <h3 className="text-lg font-medium text-black mb-2">How should I store my skincare products?</h3>
          <p>We recommend storing your items in a cool, dry place away from direct sunlight to preserve the integrity of the active botanical extracts.</p>
        </div>
        <div>
          <h3 className="text-lg font-medium text-black mb-2">Can I modify or cancel my order?</h3>
          <p>Orders can be modified within 1 hour of placement by reaching out immediately through our contact page.</p>
        </div>
      </div>
    </div>
  );

  const TermsView = () => (
    <div className="max-w-3xl mx-auto px-6 py-20 animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-6">Terms of Service</h1>
      <div className="space-y-6 text-zinc-600 font-light leading-relaxed text-sm">
        <p>Welcome to Maison Vera. By accessing our website and purchasing our products, you agree to comply with and be bound by the following terms and conditions.</p>
        <h3 className="text-base font-medium text-black pt-4">1. Use of Website</h3>
        <p>You agree to use this site only for lawful purposes and in a manner that does not infringe the rights of or restrict the use of this site by any third party.</p>
        <h3 className="text-base font-medium text-black pt-4">2. Intellectual Property</h3>
        <p>All content included on this site, such as text, graphics, logos, and images, is the property of Maison Vera and protected by international copyright laws.</p>
      </div>
    </div>
  );

  const PrivacyView = () => (
    <div className="max-w-3xl mx-auto px-6 py-20 animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-6">Privacy Policy</h1>
      <div className="space-y-6 text-zinc-600 font-light leading-relaxed text-sm">
        <p>At Maison Vera, we respect your privacy and are committed to protecting your personal data.</p>
        <h3 className="text-base font-medium text-black pt-4">Information We Collect</h3>
        <p>We collect information you provide directly to us when creating an account, making a purchase, or contacting customer support.</p>
        <h3 className="text-base font-medium text-black pt-4">How We Use Your Data</h3>
        <p>Your data is used solely to process transactions, fulfill orders, and enhance your shopping experience with personalized recommendations.</p>
      </div>
    </div>
  );

  const CookiesView = () => (
    <div className="max-w-3xl mx-auto px-6 py-20 animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-6">Cookie Policy</h1>
      <div className="space-y-6 text-zinc-600 font-light leading-relaxed text-sm">
        <p>This Cookie Policy explains how Maison Vera uses cookies and similar technologies to recognize you when you visit our website.</p>
        <h3 className="text-base font-medium text-black pt-4">What Are Cookies?</h3>
        <p>Cookies are small data files placed on your computer or mobile device when you visit a website, widely used to make websites work efficiently.</p>
      </div>
    </div>
  );

  const SocialView = ({ platform }) => (
    <div className="max-w-3xl mx-auto px-6 py-28 text-center animate-in fade-in duration-700">
      <h1 className="text-4xl font-semibold tracking-tight mb-4">Maison Vera on {platform}</h1>
      <p className="text-zinc-500 font-light mb-8">Follow our visual journal and discover daily aesthetic inspirations.</p>
      <a href="https://instagram.com" target="_blank" rel="noreferrer" className="inline-block bg-black text-white px-8 py-4 text-xs uppercase tracking-widest rounded-full font-medium hover:bg-zinc-800 transition-colors">
        Open {platform} Profile
      </a>
    </div>
  );

  return (
    <>
      <div className="min-h-screen text-black selection:bg-zinc-200 selection:text-black flex flex-col justify-between">
        <div>
          <Header />
          <main>
            {currentView === 'home' && <HomeView />}
            {currentView === 'category' && <CategoryView />}
            {currentView === 'product' && selectedProduct && <ProductDetailView />}
            {currentView === 'cart' && <CartView />}
            {currentView === 'checkout' && <CheckoutView />}
            {currentView === 'order-confirmation' && <OrderConfirmationView />}
            {currentView === 'contact' && <ContactView />}
            {currentView === 'shipping' && <ShippingView />}
            {currentView === 'faq' && <FAQView />}
            {currentView === 'terms' && <TermsView />}
            {currentView === 'privacy' && <PrivacyView />}
            {currentView === 'cookies' && <CookiesView />}
            {currentView === 'instagram' && <SocialView platform="Instagram" />}
            {currentView === 'pinterest' && <SocialView platform="Pinterest" />}
          </main>
        </div>
        
        <footer className="bg-white border-t border-zinc-100 mt-24">
          <div className="max-w-7xl mx-auto px-6 py-20">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-12 md:gap-8 mb-16">
              <div className="md:col-span-1">
                 <div className="text-xl font-semibold tracking-widest text-black uppercase mb-6 cursor-pointer" onClick={() => setCurrentView('home')}>
                  Maison Vera
                </div>
                <p className="text-sm text-zinc-500 font-light leading-relaxed max-w-xs">
                  Redefining luxury beauty through precision engineering, minimalist design, and potent botanical formulations.
                </p>
              </div>
              
              <div>
                <h4 className="text-xs font-semibold tracking-widest uppercase text-black mb-6">Explore</h4>
                <ul className="space-y-4 text-sm text-zinc-500 font-light">
                  <li><button onClick={() => navigateToCategory('Skincare')} className="hover:text-black transition-colors">Skincare</button></li>
                  <li><button onClick={() => navigateToCategory('Beauty')} className="hover:text-black transition-colors">Beauty</button></li>
                  <li><button onClick={() => navigateToCategory('Fragrance')} className="hover:text-black transition-colors">Fragrance</button></li>
                </ul>
              </div>

              <div>
                <h4 className="text-xs font-semibold tracking-widest uppercase text-black mb-6">Assistance</h4>
                <ul className="space-y-4 text-sm text-zinc-500 font-light">
                  <li><button onClick={() => setCurrentView('contact')} className="hover:text-black transition-colors">Contact Us</button></li>
                  <li><button onClick={() => setCurrentView('shipping')} className="hover:text-black transition-colors">Shipping & Returns</button></li>
                  <li><button onClick={() => setCurrentView('faq')} className="hover:text-black transition-colors">FAQ</button></li>
                </ul>
              </div>

              <div>
                <h4 className="text-xs font-semibold tracking-widest uppercase text-black mb-6">Legal</h4>
                <ul className="space-y-4 text-sm text-zinc-500 font-light">
                  <li><button onClick={() => setCurrentView('terms')} className="hover:text-black transition-colors">Terms of Service</button></li>
                  <li><button onClick={() => setCurrentView('privacy')} className="hover:text-black transition-colors">Privacy Policy</button></li>
                  <li><button onClick={() => setCurrentView('cookies')} className="hover:text-black transition-colors">Cookie Policy</button></li>
                </ul>
              </div>
            </div>

            <div className="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-zinc-100 gap-4">
              <div className="text-xs text-zinc-400 font-light">
                © 2026 Maison Vera. All rights reserved.
              </div>
              <div className="flex space-x-6 text-xs font-medium text-zinc-500 uppercase tracking-widest">
                <button onClick={() => setCurrentView('instagram')} className="hover:text-black transition-colors">Instagram</button>
                <button onClick={() => setCurrentView('pinterest')} className="hover:text-black transition-colors">Pinterest</button>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
